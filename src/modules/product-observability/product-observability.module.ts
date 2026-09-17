import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  OperationalSignalsService,
  OperationalSignalsInterceptor,
} from './operational-signals.service.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import {
  ObservabilityFirestoreProvider,
  PRODUCT_OBSERVABILITY_FIRESTORE,
} from './firestore.provider.js';
import { FeatureFlagsService } from './feature-flags.service.js';
import { ProductEventRepository } from './product-event.repository.js';
import { ProductEventOutboxService } from './product-event-outbox.service.js';
import { ProductObservabilityController } from './product-observability.controller.js';
import { ProductObservabilityService } from './product-observability.service.js';

@Module({
  imports: [ConfigModule, AuthModule, CacheModule],
  controllers: [ProductObservabilityController],
  providers: [
    OperationalSignalsService,
    { provide: APP_INTERCEPTOR, useClass: OperationalSignalsInterceptor },
    ObservabilityFirestoreProvider,
    AdminAuthGuard,
    FeatureFlagsService,
    ProductEventRepository,
    ProductEventOutboxService,
    ProductObservabilityService,
  ],
  exports: [
    PRODUCT_OBSERVABILITY_FIRESTORE,
    FeatureFlagsService,
    ProductEventOutboxService,
    ProductObservabilityService,
  ],
})
export class ProductObservabilityModule {}
