import { Global, Module } from '@nestjs/common';
import { ReconciliationLockService } from './reconciliation-lock.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, ReconciliationLockService],
  exports: [RedisService, ReconciliationLockService],
})
export class RedisModule {}
