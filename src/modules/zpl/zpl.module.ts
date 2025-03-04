import { Module } from '@nestjs/common';
import { ZplController } from './zpl.controller.js';
import { ZplService } from './zpl.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { UtilsModule } from '../../utils/utils.module.js';

@Module({
  imports: [StorageModule, QueueModule, CacheModule, UtilsModule],
  controllers: [ZplController],
  providers: [ZplService],
  exports: [ZplService],
})
export class ZplModule {}