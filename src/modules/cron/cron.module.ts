import { Module } from '@nestjs/common';
import { CronController } from './cron.controller.js';
import { CronService } from './cron.service.js';
import { CacheModule } from '../cache/cache.module.js';

@Module({
  imports: [CacheModule],
  controllers: [CronController],
  providers: [CronService],
})
export class CronModule {}
