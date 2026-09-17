import { PdfPresetsController } from './pdf-presets.controller.js';
import { PdfPresetsService } from './pdf-presets.service.js';
import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { UsersModule } from '../users/users.module.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { PdfPreparationService } from './pdf-preparation.service.js';
import { PdfPreparationController } from './pdf-preparation.controller.js';
@Module({
  imports: [
    CacheModule,
    StorageModule,
    UsersModule,
    ProductObservabilityModule,
  ],
  controllers: [PdfPresetsController, PdfPreparationController],
  providers: [PdfPreparationService, PdfPresetsService],
  exports: [PdfPreparationService, PdfPresetsService],
})
export class PdfPreparationModule {}
