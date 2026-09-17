import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ZplModule } from '../zpl/zpl.module.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { TemplateRegressionService } from './template-regression.service.js';
import { TemplateRegressionController } from './template-regression.controller.js';

@Module({
  imports: [
    AuthModule,
    CacheModule,
    StorageModule,
    ZplModule,
    ProductObservabilityModule,
  ],
  controllers: [TemplateRegressionController],
  providers: [TemplateRegressionService],
  exports: [TemplateRegressionService],
})
export class TemplateRegressionModule {}
