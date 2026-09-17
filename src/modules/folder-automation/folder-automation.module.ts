import { DriveRecipeAdapter } from './drive-recipe.adapter.js';
import { PdfPreparationModule } from '../pdf-preparation/pdf-preparation.module.js';
import { LabelTemplatesModule } from '../label-templates/label-templates.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ZplModule } from '../zpl/zpl.module.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { PublicApiCrypto } from '../public-api/public-api.crypto.js';
import { FolderAutomationController } from './folder-automation.controller.js';
import { FolderAutomationService } from './folder-automation.service.js';
import { GoogleDriveProvider } from './google-drive.provider.js';
@Module({
  imports: [
    PdfPreparationModule,
    LabelTemplatesModule,
    ConfigModule,
    AuthModule,
    CacheModule,
    StorageModule,
    ZplModule,
    ProductObservabilityModule,
  ],
  controllers: [FolderAutomationController],
  providers: [
    PublicApiCrypto,
    FolderAutomationService,
    GoogleDriveProvider,
    DriveRecipeAdapter,
  ],
  exports: [FolderAutomationService],
})
export class FolderAutomationModule {}
