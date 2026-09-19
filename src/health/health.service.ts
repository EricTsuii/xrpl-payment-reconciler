import { Injectable } from '@nestjs/common';
import { AccountsRepository } from '../accounts/accounts.repository';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { OutboxRepository } from '../outbox/outbox.repository';
import { OutboxWorker } from '../outbox/outbox.worker';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { RedisService } from '../redis/redis.service';
import { ConnectionManagerService } from '../xrpl/connection-manager.service';

type UpDown = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: UpDown;
    redis: UpDown;
    xrpl: UpDown;
    reconciliation: 'healthy' | 'degraded' | 'starting';
  };
}

@Injectable()
export class HealthService {
  private shuttingDown = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly connection: ConnectionManagerService,
    private readonly reconciliation: ReconciliationService,
    private readonly accounts: AccountsRepository,
    private readonly outbox: OutboxRepository,
    private readonly worker: OutboxWorker,
    private readonly config: AppConfigService,
  ) {}

  /** First step of shutdown: readiness turns false immediately. */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  /**
   * Ready when PostgreSQL and Redis answer, an XRPL endpoint is active (its
   * network ID checked and subscriptions made) and reconciliation has caught
   * up since that endpoint came up and is HEALTHY. DEAD webhook events and
   * disabled delivery do not affect readiness.
   */
  async readiness(): Promise<ReadinessReport> {
    const [databaseUp, redisUp] = await Promise.all([
      this.database.isReachable(),
      this.redis.isReachable(),
    ]);
    const xrplUp = this.connection.isReady();
    const health = this.reconciliation.status().status;
    const checks: ReadinessReport['checks'] = {
      database: databaseUp ? 'up' : 'down',
      redis: redisUp ? 'up' : 'down',
      xrpl: xrplUp ? 'up' : 'down',
      reconciliation:
        health === 'HEALTHY' ? 'healthy' : health === 'DEGRADED' ? 'degraded' : 'starting',
    };
    const ready =
      !this.shuttingDown &&
      databaseUp &&
      redisUp &&
      xrplUp &&
      health === 'HEALTHY' &&
      this.reconciliation.isCaughtUp();
    return { ready, checks };
  }

  async status() {
    const [databaseUp, redisUp] = await Promise.all([
      this.database.isReachable(),
      this.redis.isReachable(),
    ]);
    const summary = databaseUp
      ? await this.accounts.enabledSummary(this.config.networkId)
      : { enabled: 0, minimumCursor: null };
    const counts = databaseUp ? await this.outbox.counts() : { pending: 0, dead: 0 };
    const xrpl = this.connection.status();
    const reconciliation = this.reconciliation.status();
    return {
      database: databaseUp ? 'up' : 'down',
      redis: redisUp ? 'up' : 'down',
      xrpl: {
        connected: xrpl.connected,
        endpoint: xrpl.endpoint,
        networkId: xrpl.networkId,
        validatedLedger: xrpl.validatedLedger,
        lastLedgerSeenAt: xrpl.lastLedgerSeenAt,
      },
      reconciliation: {
        status: reconciliation.status,
        enabledAccounts: summary.enabled,
        minimumCursor: summary.minimumCursor,
        lastSuccessfulCycleAt: reconciliation.lastSuccessfulCycleAt,
      },
      outbox: {
        deliveryEnabled: this.worker.deliveryEnabled,
        pending: counts.pending,
        dead: counts.dead,
      },
    };
  }
}
