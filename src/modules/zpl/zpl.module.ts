import { Module, forwardRef } from '@nestjs/common';
import { ZplController } from './zpl.controller.js';
import { ZplService } from './zpl.service.js';
import { ZplValidatorService } from './validation/zpl-validator.service.js';
import { ValidationMetricsService } from './logging/validation-metrics.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { UtilsModule } from '../../utils/utils.module.js';
import { UsersModule } from '../users/users.module.js';
import { GoogleAuthProvider } from '../../config/google-auth.provider.js';

@Module({
  imports: [
    StorageModule,
    QueueModule,
    CacheModule,
    UtilsModule,
    forwardRef(() => UsersModule),
  ],
  controllers: [ZplController],
  providers: [ZplService, ZplValidatorService, ValidationMetricsService, GoogleAuthProvider],
  exports: [ZplService, ZplValidatorService],
})
export class ZplModule {}
