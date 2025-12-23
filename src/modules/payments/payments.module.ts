import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';

@Module({
  imports: [CacheModule, AnalyticsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
