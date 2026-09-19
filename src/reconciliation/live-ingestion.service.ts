import { Injectable, Logger } from '@nestjs/common';
import { AccountsRepository } from '../accounts/accounts.repository';
import { AppConfigService } from '../config/config.service';
import { PaymentsRepository } from '../payments/payments.repository';
import { envelopeFromStream, PaymentNormalizerService } from '../xrpl/payment-normalizer.service';
import type { TransactionStreamMessage } from '../xrpl/types';

/**
 * The low-latency path. Validated stream transactions go through the same
 * normalizer and idempotent storage as reconciliation. It never touches a
 * cursor: anything it misses, reconciliation finds.
 */
@Injectable()
export class LiveIngestionService {
  private readonly logger = new Logger('LiveIngestion');
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly accounts: AccountsRepository,
    private readonly normalizer: PaymentNormalizerService,
    private readonly payments: PaymentsRepository,
    private readonly config: AppConfigService,
  ) {}

  /** Queues a message; messages are processed one at a time, in arrival order. */
  handle(message: TransactionStreamMessage): void {
    if (this.stopped) {
      return;
    }
    this.chain = this.chain
      .then(() => this.process(message))
      .catch((error: unknown) => {
        this.logger.warn(
          `live transaction not processed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
  }

  /** Resolves when every queued message has been processed. */
  async drain(): Promise<void> {
    await this.chain;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.chain;
  }

  private async process(message: TransactionStreamMessage): Promise<void> {
    const built = envelopeFromStream(message, this.config.networkId);
    if (!built.ok) {
      // Proposed or malformed: never a payment. Reconciliation covers it.
      this.logger.debug(`live message ignored: ${built.reason}`);
      return;
    }
    const envelope = built.envelope;
    const tx = envelope.tx as Record<string, unknown>;
    if (typeof tx.Destination !== 'string') {
      return;
    }
    const account = await this.accounts.findEnabledByAddress(this.config.networkId, tx.Destination);
    if (account === undefined) {
      // Not an enabled monitored destination (or still activating).
      return;
    }

    const result = this.normalizer.normalize(envelope, account);
    if (result.outcome === 'INTEGRITY_ERROR') {
      this.logger.error(
        `live transaction ${envelope.hash} failed integrity checks: ${result.reason}`,
      );
      return;
    }
    if (
      result.outcome === 'UNSUPPORTED_DELIVERED_AMOUNT' ||
      result.outcome === 'UNSUPPORTED_ASSET_TYPE'
    ) {
      this.logger.warn(`payment ${envelope.hash} skipped: ${result.outcome}`);
      return;
    }
    if (result.outcome !== 'ACCEPTED') {
      return;
    }
    const stored = await this.payments.persist(result.payment);
    if (stored.outcome === 'ACCEPTED') {
      this.logger.log(
        `payment ${envelope.hash} recorded from the live stream (ctid ${result.payment.ctid})`,
      );
    } else if (stored.outcome === 'INTEGRITY_ERROR') {
      this.logger.error(`live payment ${envelope.hash} rejected: ${stored.reason}`);
    }
  }
}
