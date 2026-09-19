import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { REDIS_LOCK_REFRESH_MS, REDIS_LOCK_TTL_MS } from '../common/constants';
import { AppConfigService } from '../config/config.service';
import { RedisService } from './redis.service';

const REFRESH_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

/**
 * A held per-account lease. It refreshes itself every 20 seconds while held
 * and records a loss; the holder checks `assertOwned` before durable steps.
 */
export class Lease {
  private lost = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly key: string,
    readonly token: string,
    private readonly locks: ReconciliationLockService,
  ) {}

  /** @internal */
  startRefreshing(intervalMs: number): void {
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.timer.unref();
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** Extends the lease if this holder still owns it. Returns ownership. */
  async refresh(): Promise<boolean> {
    if (this.lost) {
      return false;
    }
    let owned: boolean;
    try {
      owned = await this.locks.refresh(this.key, this.token);
    } catch {
      owned = false;
    }
    if (!owned) {
      this.lost = true;
    }
    return owned;
  }

  /** Confirms and extends ownership right before a durable step. */
  async assertOwned(): Promise<void> {
    if (!(await this.refresh())) {
      throw new LeaseLostError(this.key);
    }
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.locks.release(this.key, this.token);
    } catch {
      // The lease expires on its own.
    }
  }
}

export class LeaseLostError extends Error {
  constructor(key: string) {
    super(`reconciliation lease lost: ${key}`);
    this.name = 'LeaseLostError';
  }
}

/** Per-account reconciliation leases in Redis. */
@Injectable()
export class ReconciliationLockService {
  private readonly logger = new Logger('ReconciliationLock');

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  key(accountId: string): string {
    return `xrpl-reconciler:reconcile:${this.config.networkId}:${accountId}`;
  }

  /** Acquires the account lease, or returns undefined if another owner holds it. */
  async acquire(accountId: string): Promise<Lease | undefined> {
    const key = this.key(accountId);
    const token = randomUUID();
    const result = await this.redis.client.set(key, token, { NX: true, PX: REDIS_LOCK_TTL_MS });
    if (result !== 'OK') {
      this.logger.debug(`lease for account ${accountId} is held elsewhere`);
      return undefined;
    }
    const lease = new Lease(key, token, this);
    lease.startRefreshing(REDIS_LOCK_REFRESH_MS);
    return lease;
  }

  /** Acquires the lease, retrying for a bounded time while another owner holds it. */
  async acquireWithin(accountId: string, waitMs: number, stepMs = 250): Promise<Lease | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const lease = await this.acquire(accountId);
      if (lease !== undefined || Date.now() >= deadline) {
        return lease;
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }

  async refresh(key: string, token: string): Promise<boolean> {
    const result = await this.redis.client.eval(REFRESH_SCRIPT, {
      keys: [key],
      arguments: [token, String(REDIS_LOCK_TTL_MS)],
    });
    return result === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    const result = await this.redis.client.eval(RELEASE_SCRIPT, {
      keys: [key],
      arguments: [token],
    });
    return result === 1;
  }
}
