import { Module } from '@nestjs/common';
import { AccountsStoreModule } from '../accounts/accounts-store.module';
import { PaymentsModule } from '../payments/payments.module';
import { XrplModule } from '../xrpl/xrpl.module';
import { LiveIngestionService } from './live-ingestion.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [XrplModule, AccountsStoreModule, PaymentsModule],
  providers: [ReconciliationService, ReconciliationScheduler, LiveIngestionService],
  exports: [ReconciliationService, ReconciliationScheduler, LiveIngestionService],
})
export class ReconciliationModule {}
