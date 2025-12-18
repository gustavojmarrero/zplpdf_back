import { Module } from '@nestjs/common';
import { CronController } from './cron.controller.js';
import { CronService } from './cron.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { PeriodModule } from '../../common/services/period.module.js';

@Module({
  imports: [CacheModule, PeriodModule],
  controllers: [CronController],
  providers: [CronService],
})
export class CronModule {}
