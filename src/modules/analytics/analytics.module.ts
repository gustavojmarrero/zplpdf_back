import { Module } from '@nestjs/common';
import { GA4Service } from './ga4.service.js';

@Module({
  providers: [GA4Service],
  exports: [GA4Service],
})
export class AnalyticsModule {}
