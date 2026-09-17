import { Module } from '@nestjs/common';
import { GrowthMetricsModule } from '../growth-metrics/growth-metrics.module.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { BillingModule } from '../billing/billing.module.js';

@Module({
  imports: [PaymentsModule, BillingModule, GrowthMetricsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
