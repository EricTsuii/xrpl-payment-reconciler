import { Module } from '@nestjs/common';
import { AccountsRepository } from './accounts.repository';

/**
 * Account and cursor persistence. Separate from AccountsModule so that the
 * reconciliation module can use it while AccountsModule uses reconciliation,
 * without a module cycle.
 */
@Module({
  providers: [AccountsRepository],
  exports: [AccountsRepository],
})
export class AccountsStoreModule {}
