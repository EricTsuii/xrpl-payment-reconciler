import { Module } from '@nestjs/common';
import { WebhookDeliveryService } from './webhook-delivery.service';

@Module({
  providers: [WebhookDeliveryService],
  exports: [WebhookDeliveryService],
})
export class WebhooksModule {}
