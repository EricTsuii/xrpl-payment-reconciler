import { Module } from '@nestjs/common';
import { AccountsStoreModule } from '../accounts/accounts-store.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { XrplModule } from '../xrpl/xrpl.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { LifecycleService } from './lifecycle.service';

@Module({
  imports: [XrplModule, ReconciliationModule, OutboxModule, AccountsStoreModule],
  controllers: [HealthController],
  providers: [HealthService, LifecycleService],
  exports: [HealthService],
})
export class HealthModule {}
