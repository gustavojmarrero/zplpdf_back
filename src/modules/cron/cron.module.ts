import { Module, forwardRef } from '@nestjs/common';
import { CronController } from './cron.controller.js';
import { CronService } from './cron.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { PeriodModule } from '../../common/services/period.module.js';
import { AdminModule } from '../admin/admin.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';

@Module({
  imports: [CacheModule, PeriodModule, forwardRef(() => AdminModule), AnalyticsModule],
  controllers: [CronController],
  providers: [CronService],
})
export class CronModule {}
