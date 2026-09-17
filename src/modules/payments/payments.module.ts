import { Module, forwardRef } from '@nestjs/common';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PlansController } from './plans.controller.js';
import { PlanCatalogService } from './plan-catalog.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { ExchangeRateService } from '../admin/services/exchange-rate.service.js';
import { EmailModule } from '../email/email.module.js';
import { BillingModule } from '../billing/billing.module.js';

@Module({
  imports: [
    CacheModule,
    AnalyticsModule,
    forwardRef(() => EmailModule),
    BillingModule,
  ],
  controllers: [PaymentsController, PlansController],
  providers: [PaymentsService, PlanCatalogService, ExchangeRateService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
