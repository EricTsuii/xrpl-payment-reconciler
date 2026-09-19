import { Injectable, Logger } from '@nestjs/common';
import { AccountsRepository } from '../accounts/accounts.repository';
import { AppConfigService } from '../config/config.service';
import { PaymentsRepository } from '../payments/payments.repository';
import {
  Lease,
  LeaseLostError,
  ReconciliationLockService,
} from '../redis/reconciliation-lock.service';
import { ConnectionManagerService, XrplUnavailableError } from '../xrpl/connection-manager.service';
import { HISTORY_UNAVAILABLE_ERRORS, LedgerServerError } from '../xrpl/ledger-client.interface';
import {
  envelopeFromAccountTx,
  MonitoredAccountRef,
  PaymentNormalizerService,
} from '../xrpl/payment-normalizer.service';

export type ReconciliationHealth = 'STARTING' | 'HEALTHY' | 'DEGRADED';

/** OK: range fully inspected. DEGRADED: integrity or history problem. FAILED: transient. */
export type ReconcileOutcome =
  { kind: 'OK' } | { kind: 'DEGRADED'; reason: string } | { kind: 'FAILED'; reason: string };

type ScanOutcome = ReconcileOutcome | { kind: 'INSUFFICIENT_HISTORY'; reason: string };

/**
 * The correctness path. For each enabled account, under its Redis lease, it
 * reads account_tx from the cursor to a fixed validated ledger, pushes every
 * transaction through the single normalizer and idempotent storage, and
 * moves the cursor only when the whole range was inspected.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger('Reconciliation');
  private health: ReconciliationHealth = 'STARTING';
  private lastSuccessfulCycleAt: Date | undefined;
  private connectionEpoch = 0;
  private reconciledEpoch = 0;
  private running: Promise<void> | undefined;
  private pending = false;
  private stopped = false;
  /** True while a cycle itself switches endpoints to find account history. */
  private switchingForHistory = false;

  constructor(
    private readonly connection: ConnectionManagerService,
    private readonly accounts: AccountsRepository,
    private readonly locks: ReconciliationLockService,
    private readonly normalizer: PaymentNormalizerService,
    private readonly payments: PaymentsRepository,
    private readonly config: AppConfigService,
  ) {}

  status(): { status: ReconciliationHealth; lastSuccessfulCycleAt: string | null } {
    return {
      status: this.health,
      lastSuccessfulCycleAt: this.lastSuccessfulCycleAt?.toISOString() ?? null,
    };
  }

  /**
   * True once a full cycle has completed after the latest endpoint bootstrap:
   * a reconnect or failover is not ready until its gap is reconciled.
   */
  isCaughtUp(): boolean {
    return this.connectionEpoch > 0 && this.reconciledEpoch === this.connectionEpoch;
  }

  /**
   * Called on every endpoint bootstrap. A reconnect or failover needs a new
   * cycle. A switch made by a cycle looking for history does not: that cycle
   * rescans the range itself, and triggering another would bounce between
   * two endpoints that both lack the history.
   */
  onEndpointConnected(): void {
    this.connectionEpoch += 1;
    if (!this.switchingForHistory) {
      void this.runCycle();
    }
  }

  /** Single-flight and coalescing: a call during a cycle schedules one more. */
  runCycle(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.pending = true;
    if (this.running === undefined) {
      this.running = (async () => {
        try {
          while (this.pending && !this.stopped) {
            this.pending = false;
            await this.cycle();
          }
        } finally {
          this.running = undefined;
        }
      })();
    }
    return this.running;
  }

  /** Stops scheduling and waits for the cycle in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  /**
   * Reconciles one account under a lease the caller holds. With `target`
   * the range end is fixed by the caller (activation H1, disable Hstop).
   */
  async reconcileAccount(
    account: MonitoredAccountRef,
    lease: Lease,
    target?: number,
  ): Promise<ReconcileOutcome> {
    const cursor = await this.accounts.getCursor(account.id);
    if (cursor === undefined) {
      return { kind: 'FAILED', reason: 'account has no cursor' };
    }

    let end: number;
    try {
      end = target ?? (await this.connection.getValidatedLedgerIndex());
    } catch (error) {
      return { kind: 'FAILED', reason: describe(error) };
    }
    if (end <= cursor) {
      return { kind: 'OK' };
    }

    const outcome = await this.reconcileRange(account, cursor + 1, end, lease);
    if (outcome.kind !== 'OK') {
      await this.accounts.recordError(account.id, `${outcome.kind}: ${outcome.reason}`);
      this.logger.warn(
        `account ${account.id} range ${cursor + 1}..${end} not reconciled (${outcome.kind}): ${outcome.reason}`,
      );
      return outcome;
    }

    try {
      await lease.assertOwned();
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return { kind: 'FAILED', reason: 'reconciliation lease lost before cursor update' };
      }
      throw error;
    }
    if (!(await this.accounts.advanceCursor(account.id, cursor, end))) {
      return { kind: 'FAILED', reason: 'cursor changed during reconciliation' };
    }
    this.logger.debug(`account ${account.id} reconciled through ledger ${end}`);
    return { kind: 'OK' };
  }

  private async cycle(): Promise<void> {
    const epoch = this.connectionEpoch;
    if (!this.connection.isReady()) {
      return;
    }
    let degraded = false;
    let failed = false;

    let enabled: MonitoredAccountRef[];
    try {
      enabled = await this.accounts.listEnabled(this.config.networkId);
    } catch (error) {
      this.logger.warn(`reconciliation cycle could not list accounts: ${describe(error)}`);
      return;
    }

    for (const account of enabled) {
      if (this.stopped) {
        return;
      }
      let lease: Lease | undefined;
      try {
        lease = await this.locks.acquire(account.id);
      } catch (error) {
        this.logger.warn(`lease for account ${account.id} unavailable: ${describe(error)}`);
        failed = true;
        continue;
      }
      if (lease === undefined) {
        // Another owner is reconciling this account right now.
        continue;
      }
      try {
        const outcome = await this.reconcileAccount(account, lease);
        degraded ||= outcome.kind === 'DEGRADED';
        failed ||= outcome.kind === 'FAILED';
      } catch (error) {
        this.logger.warn(`account ${account.id} reconciliation failed: ${describe(error)}`);
        failed = true;
      } finally {
        await lease.release();
      }
    }

    if (degraded) {
      this.health = 'DEGRADED';
    } else if (!failed) {
      this.health = 'HEALTHY';
      this.lastSuccessfulCycleAt = new Date();
      if (epoch === this.connectionEpoch && this.connection.isReady()) {
        this.reconciledEpoch = epoch;
      }
    }
  }

  /**
   * Scans the range on the active endpoint; if that endpoint lacks the
   * history, switches endpoints once and scans the whole range again.
   */
  private async reconcileRange(
    account: MonitoredAccountRef,
    from: number,
    to: number,
    lease: Lease,
  ): Promise<ReconcileOutcome> {
    const first = await this.scan(account, from, to, lease);
    if (first.kind !== 'INSUFFICIENT_HISTORY') {
      return first;
    }
    this.logger.warn(`active endpoint lacks history for ${from}..${to}: ${first.reason}`);
    this.switchingForHistory = true;
    try {
      await this.connection.switchEndpoint('insufficient account_tx history');
    } catch (error) {
      return { kind: 'FAILED', reason: describe(error) };
    } finally {
      this.switchingForHistory = false;
    }
    const second = await this.scan(account, from, to, lease);
    if (second.kind === 'INSUFFICIENT_HISTORY') {
      return { kind: 'DEGRADED', reason: `no endpoint covers ${from}..${to}: ${second.reason}` };
    }
    return second;
  }

  private async scan(
    account: MonitoredAccountRef,
    from: number,
    to: number,
    lease: Lease,
  ): Promise<ScanOutcome> {
    const endpoint = this.connection.status().endpoint;
    try {
      // Never ask beyond this endpoint's validated ledger: the server would
      // answer with the same error it uses for missing history.
      const validated = await this.connection.getValidatedLedgerIndex();
      if (validated < to) {
        return { kind: 'FAILED', reason: `endpoint validated ledger ${validated} is behind ${to}` };
      }
    } catch (error) {
      return { kind: 'FAILED', reason: describe(error) };
    }

    let marker: unknown = undefined;
    let firstPage = true;
    for (;;) {
      if (lease.isLost) {
        return { kind: 'FAILED', reason: 'reconciliation lease lost' };
      }

      let page;
      try {
        page = await this.connection.getAccountTransactions({
          account: account.address,
          ledgerIndexMin: from,
          ledgerIndexMax: to,
          marker,
        });
      } catch (error) {
        if (error instanceof LedgerServerError && HISTORY_UNAVAILABLE_ERRORS.has(error.code)) {
          return { kind: 'INSUFFICIENT_HISTORY', reason: error.code };
        }
        if (error instanceof XrplUnavailableError || error instanceof LedgerServerError) {
          return { kind: 'FAILED', reason: describe(error) };
        }
        throw error;
      }
      if (this.connection.status().endpoint !== endpoint) {
        // A transport failover happened mid-pagination; markers are opaque
        // and belong to the endpoint that issued them.
        return { kind: 'FAILED', reason: 'endpoint changed during pagination' };
      }

      if (page.validated === false) {
        return { kind: 'DEGRADED', reason: 'account_tx reported validated=false' };
      }
      if (firstPage && (page.ledgerIndexMin === undefined || page.ledgerIndexMax === undefined)) {
        return {
          kind: 'INSUFFICIENT_HISTORY',
          reason: 'account_tx did not report its ledger range',
        };
      }
      if (
        (page.ledgerIndexMin !== undefined && page.ledgerIndexMin > from) ||
        (page.ledgerIndexMax !== undefined && page.ledgerIndexMax < to)
      ) {
        return {
          kind: 'INSUFFICIENT_HISTORY',
          reason: `server covered ${String(page.ledgerIndexMin)}..${String(page.ledgerIndexMax)}`,
        };
      }

      for (const entry of page.transactions) {
        const outcome = await this.ingest(entry, account, from, to);
        if (outcome !== undefined) {
          return outcome;
        }
      }

      if (page.marker === undefined || page.marker === null) {
        return { kind: 'OK' };
      }
      marker = page.marker;
      firstPage = false;
    }
  }

  /** Processes one account_tx entry; returns an outcome only when it must stop the scan. */
  private async ingest(
    entry: unknown,
    account: MonitoredAccountRef,
    from: number,
    to: number,
  ): Promise<ReconcileOutcome | undefined> {
    const built = envelopeFromAccountTx(entry, this.config.networkId);
    if (!built.ok) {
      return { kind: 'DEGRADED', reason: `integrity: ${built.reason}` };
    }
    const envelope = built.envelope;
    if (envelope.ledgerIndex < from || envelope.ledgerIndex > to) {
      return {
        kind: 'DEGRADED',
        reason: `integrity: ${envelope.hash} in ledger ${envelope.ledgerIndex} is outside ${from}..${to}`,
      };
    }

    const result = this.normalizer.normalize(envelope, account);
    switch (result.outcome) {
      case 'ACCEPTED': {
        const stored = await this.payments.persist(result.payment);
        if (stored.outcome === 'INTEGRITY_ERROR') {
          return { kind: 'DEGRADED', reason: `integrity: ${stored.reason}` };
        }
        if (stored.outcome === 'ACCEPTED') {
          this.logger.log(
            `payment ${envelope.hash} recorded by reconciliation (ctid ${result.payment.ctid})`,
          );
        }
        return undefined;
      }
      case 'INTEGRITY_ERROR':
        return { kind: 'DEGRADED', reason: `integrity: ${envelope.hash}: ${result.reason}` };
      case 'UNSUPPORTED_DELIVERED_AMOUNT':
      case 'UNSUPPORTED_ASSET_TYPE':
        this.logger.warn(`payment ${envelope.hash} skipped: ${result.outcome}`);
        return undefined;
      default:
        return undefined;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
