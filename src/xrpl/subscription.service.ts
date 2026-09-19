import { Injectable, Logger } from '@nestjs/common';
import { ConnectionManagerService } from './connection-manager.service';

/**
 * Live account subscriptions. Subscribing is a latency optimization: an
 * account that is not subscribed still gets every payment through the
 * reconciliation path.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger('SubscriptionService');

  constructor(private readonly connection: ConnectionManagerService) {}

  /** Accounts to subscribe when the first endpoint comes up. */
  initialize(addresses: string[]): void {
    this.connection.setAccounts(addresses);
  }

  async subscribe(address: string): Promise<void> {
    await this.connection.subscribeAccount(address);
    this.logger.log(`subscribed ${address}`);
  }

  /** Resolves only after the server confirmed the unsubscribe. */
  async unsubscribe(address: string): Promise<void> {
    await this.connection.unsubscribeAccount(address);
    this.logger.log(`unsubscribed ${address}`);
  }
}
