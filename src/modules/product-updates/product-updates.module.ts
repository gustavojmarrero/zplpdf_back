import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { ProductUpdatesController } from './product-updates.controller.js';
import { ProductUpdatesService } from './product-updates.service.js';
import { TourProgressRepository } from './tour-progress.repository.js';

@Module({
  imports: [ConfigModule, AuthModule, CacheModule, ProductObservabilityModule],
  controllers: [ProductUpdatesController],
  providers: [TourProgressRepository, ProductUpdatesService],
  exports: [ProductUpdatesService],
})
export class ProductUpdatesModule {}
