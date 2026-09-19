import { Injectable, Logger } from '@nestjs/common';
import { MAX_MONITORED_ACCOUNTS } from '../common/constants';
import { ApiError } from '../common/errors/api-error';
import { AppConfigService } from '../config/config.service';
import { HealthService } from '../health/health.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { ReconciliationLockService } from '../redis/reconciliation-lock.service';
import { ConnectionManagerService } from '../xrpl/connection-manager.service';
import { SubscriptionService } from '../xrpl/subscription.service';
import { AccountExistsError, AccountsRepository, AccountWithCursor } from './accounts.repository';
import type { CreateAccountDto } from './dto/create-account.dto';

/** How long a lifecycle operation waits for a periodic cycle to release the lease. */
const LEASE_WAIT_MS = 10_000;

@Injectable()
export class AccountsService {
  private readonly logger = new Logger('Accounts');

  constructor(
    private readonly accounts: AccountsRepository,
    private readonly connection: ConnectionManagerService,
    private readonly subscriptions: SubscriptionService,
    private readonly locks: ReconciliationLockService,
    private readonly reconciliation: ReconciliationService,
    private readonly health: HealthService,
    private readonly config: AppConfigService,
  ) {}

  list(): Promise<AccountWithCursor[]> {
    return this.accounts.listAll(this.config.networkId);
  }

  /**
   * Activates monitoring. The H0/H1 flow closes the gap between creating the
   * cursor and the subscription taking effect:
   * H0 → cursor = H0 → lease → subscribe → H1 → reconcile H0+1..H1 → enabled.
   */
  async activate(dto: CreateAccountDto): Promise<{ created: boolean; account: AccountWithCursor }> {
    const networkId = this.config.networkId;
    if (!(await this.health.readiness()).ready) {
      throw new ApiError('SERVICE_NOT_READY', 'The service is not ready; retry shortly.');
    }

    const existing = await this.accounts.findByAddress(networkId, dto.address);
    if (existing?.enabled === true) {
      throw new ApiError('ACCOUNT_ALREADY_MONITORED', 'Account is already monitored.');
    }
    if ((await this.accounts.enabledSummary(networkId)).enabled >= MAX_MONITORED_ACCOUNTS) {
      throw limitReached();
    }

    const info = await this.xrpl(() => this.connection.getAccountInfo(dto.address));
    if (!info.found) {
      throw new ApiError('ACCOUNT_NOT_FOUND', 'The account does not exist in a validated ledger.');
    }

    const h0 = await this.xrpl(() => this.connection.getValidatedLedgerIndex());
    let account: AccountWithCursor;
    if (existing === undefined) {
      try {
        account = await this.accounts.createDisabled(networkId, dto.address, dto.label ?? null, h0);
      } catch (error) {
        if (error instanceof AccountExistsError) {
          throw new ApiError('ACCOUNT_ALREADY_MONITORED', 'Account is already monitored.');
        }
        throw error;
      }
    } else {
      // Reactivation: monitoring restarts at H0; the disabled period is not backfilled.
      await this.accounts.resetCursor(existing.id, h0, dto.label);
      account = existing;
    }

    const lease = await this.locks.acquireWithin(account.id, LEASE_WAIT_MS);
    if (lease === undefined) {
      await this.rollbackActivation(account, existing === undefined, false);
      throw activationFailed();
    }

    let subscribed = false;
    try {
      await this.subscriptions.subscribe(account.address);
      subscribed = true;
      const h1 = await this.connection.getValidatedLedgerIndex();
      const outcome = await this.reconciliation.reconcileAccount(account, lease, h1);
      if (outcome.kind !== 'OK') {
        throw new Error(`activation reconciliation ${outcome.kind}: ${outcome.reason}`);
      }
      if (!(await this.accounts.enableWithinLimit(account.id, networkId, MAX_MONITORED_ACCOUNTS))) {
        await this.rollbackActivation(account, existing === undefined, subscribed);
        throw limitReached();
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      this.logger.warn(`activation of ${account.address} failed: ${describe(error)}`);
      await this.rollbackActivation(account, existing === undefined, subscribed);
      throw activationFailed();
    } finally {
      await lease.release();
    }

    const activated = await this.accounts.findById(account.id);
    if (activated === undefined) {
      throw new Error('activated account disappeared');
    }
    this.logger.log(`monitoring ${activated.address} from ledger ${h0}`);
    return { created: existing === undefined, account: activated };
  }

  /**
   * Disables monitoring without losing the tail: unsubscribe (confirmed) →
   * capture Hstop → reconcile cursor+1..Hstop → disabled.
   */
  async disable(id: string): Promise<void> {
    const account = await this.accounts.findById(id);
    if (account === undefined || !account.enabled) {
      throw new ApiError('ACCOUNT_NOT_MONITORED', 'Account is not monitored.');
    }

    const lease = await this.locks.acquireWithin(account.id, LEASE_WAIT_MS);
    if (lease === undefined) {
      throw disableFailed();
    }
    let unsubscribed = false;
    try {
      await this.subscriptions.unsubscribe(account.address);
      unsubscribed = true;
      const hStop = await this.connection.getValidatedLedgerIndex();
      const outcome = await this.reconciliation.reconcileAccount(account, lease, hStop);
      if (outcome.kind !== 'OK') {
        throw new Error(`final reconciliation ${outcome.kind}: ${outcome.reason}`);
      }
      await this.accounts.disable(account.id);
      this.logger.log(`stopped monitoring ${account.address} after ledger ${hStop}`);
    } catch (error) {
      this.logger.warn(`disabling ${account.address} failed: ${describe(error)}`);
      if (unsubscribed) {
        await this.subscriptions.subscribe(account.address).catch(() => undefined);
      }
      throw disableFailed();
    } finally {
      await lease.release();
    }
  }

  private async rollbackActivation(
    account: AccountWithCursor,
    isNew: boolean,
    subscribed: boolean,
  ): Promise<void> {
    if (subscribed) {
      await this.subscriptions.unsubscribe(account.address).catch(() => undefined);
    }
    if (isNew && !(await this.accounts.deleteIfUnused(account.id))) {
      // Payments from H0..H1 already reference it; keep it disabled.
      this.logger.warn(`account ${account.address} kept disabled: it already has payments`);
    }
  }

  /** Runs an XRPL read for an API request; an outage means the service is not ready. */
  private async xrpl<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      this.logger.warn(`XRPL request failed: ${describe(error)}`);
      throw new ApiError('SERVICE_NOT_READY', 'The XRPL endpoint is not available; retry shortly.');
    }
  }
}

function limitReached(): ApiError {
  return new ApiError(
    'ACCOUNT_LIMIT_REACHED',
    `At most ${MAX_MONITORED_ACCOUNTS} accounts can be monitored.`,
  );
}

function activationFailed(): ApiError {
  return new ApiError('ACCOUNT_ACTIVATION_FAILED', 'Account activation failed; retry shortly.');
}

function disableFailed(): ApiError {
  return new ApiError('ACCOUNT_DISABLE_FAILED', 'Disabling the account failed; retry shortly.');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
