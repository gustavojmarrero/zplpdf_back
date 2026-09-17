import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { PublicApiCrypto } from '../public-api/public-api.crypto.js';
import { DirectPrintController } from './direct-print.controller.js';
import { DirectPrintService } from './direct-print.service.js';
import { PrintNodeProvider } from './printnode.provider.js';
import { OwnedPdfService } from './owned-pdf.service.js';
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    CacheModule,
    StorageModule,
    ProductObservabilityModule,
  ],
  controllers: [DirectPrintController],
  providers: [
    PublicApiCrypto,
    DirectPrintService,
    PrintNodeProvider,
    OwnedPdfService,
  ],
  exports: [DirectPrintService],
})
export class DirectPrintModule {}
