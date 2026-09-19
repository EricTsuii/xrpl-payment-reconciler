import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { XrplModule } from '../xrpl/xrpl.module';
import { AccountsStoreModule } from './accounts-store.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

@Module({
  imports: [AccountsStoreModule, XrplModule, ReconciliationModule, HealthModule],
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
