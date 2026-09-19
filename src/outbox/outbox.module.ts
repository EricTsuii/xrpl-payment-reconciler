import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { OutboxRepository } from './outbox.repository';
import { OutboxWorker } from './outbox.worker';

@Module({
  imports: [WebhooksModule],
  providers: [OutboxRepository, OutboxWorker],
  exports: [OutboxRepository, OutboxWorker],
})
export class OutboxModule {}
