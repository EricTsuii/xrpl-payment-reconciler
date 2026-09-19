import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AccountsRepository } from '../accounts/accounts.repository';
import { RECONCILE_INTERVAL_MS } from '../common/constants';
import { AppConfigService } from '../config/config.service';
import { ConnectionManagerService } from '../xrpl/connection-manager.service';
import { SubscriptionService } from '../xrpl/subscription.service';
import { LiveIngestionService } from './live-ingestion.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Starts the ingestion paths: subscribes the enabled accounts, connects to
 * XRPL, and runs reconciliation at startup, after every (re)connect or
 * failover, and every 30 seconds. A new cycle never overlaps a running one.
 */
@Injectable()
export class ReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger('ReconciliationScheduler');
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly live: LiveIngestionService,
    private readonly connection: ConnectionManagerService,
    private readonly subscriptions: SubscriptionService,
    private readonly accounts: AccountsRepository,
    private readonly config: AppConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const enabled = await this.accounts.listEnabled(this.config.networkId);
    this.subscriptions.initialize(enabled.map((account) => account.address));

    this.connection.onTransaction((message) => this.live.handle(message));
    this.connection.onConnected(() => {
      if (!this.stopped) {
        this.reconciliation.onEndpointConnected();
      }
    });

    this.timer = setInterval(() => this.trigger(), RECONCILE_INTERVAL_MS);
    this.timer.unref();

    this.logger.log(`starting with ${enabled.length} enabled account(s)`);
    // Connection failures are retried in the background; readiness reports them.
    void this.connection.start();
  }

  /** Stops the periodic cycle and waits for the one in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.reconciliation.stop();
  }

  private trigger(): void {
    if (!this.stopped) {
      void this.reconciliation.runCycle();
    }
  }
}
