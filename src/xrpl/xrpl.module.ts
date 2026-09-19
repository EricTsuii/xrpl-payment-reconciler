import { Module } from '@nestjs/common';
import { ConnectionManagerService } from './connection-manager.service';
import { LEDGER_CLIENT_FACTORY, LedgerClientFactory } from './ledger-client.interface';
import { PaymentNormalizerService } from './payment-normalizer.service';
import { SubscriptionService } from './subscription.service';
import { XrplLedgerClient } from './xrpl-ledger.client';

const realClientFactory: LedgerClientFactory = (url) => new XrplLedgerClient(url);

@Module({
  providers: [
    { provide: LEDGER_CLIENT_FACTORY, useValue: realClientFactory },
    ConnectionManagerService,
    SubscriptionService,
    PaymentNormalizerService,
  ],
  exports: [ConnectionManagerService, SubscriptionService, PaymentNormalizerService],
})
export class XrplModule {}
