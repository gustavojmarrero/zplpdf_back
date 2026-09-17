import { ApiTestController } from './api-test.controller.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '../cache/cache.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ZplModule } from '../zpl/zpl.module.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { ApiTemplateAdapter } from './api-template.adapter.js';
import { ApiCredentialsService } from './api-credentials.service.js';
import { ApiCallbacksService } from './api-callbacks.service.js';
import { ApiJobsService } from './api-jobs.service.js';
import { PublicApiCrypto } from './public-api.crypto.js';
import { CallbackTransport } from './callback-transport.service.js';
import { ApiConversionAdapter } from './api-conversion.adapter.js';
import { PUBLIC_API_CONVERSION } from './public-api.types.js';
import { ApiKeyGuard } from './api-key.guard.js';
import {
  PublicApiJobsController,
  PublicApiManagementController,
} from './public-api.controller.js';
@Module({
  imports: [
    ConfigModule,
    CacheModule,
    AuthModule,
    ZplModule,
    ProductObservabilityModule,
  ],
  controllers: [
    PublicApiManagementController,
    PublicApiJobsController,
    ApiTestController,
  ],
  providers: [
    ApiTemplateAdapter,
    ApiCredentialsService,
    ApiCallbacksService,
    ApiJobsService,
    PublicApiCrypto,
    CallbackTransport,
    ApiKeyGuard,
    { provide: PUBLIC_API_CONVERSION, useClass: ApiConversionAdapter },
  ],
  exports: [ApiJobsService, ApiCallbacksService],
})
export class PublicApiModule {}
