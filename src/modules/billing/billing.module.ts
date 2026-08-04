import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { CfdiService } from './cfdi.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { FacturamaModule } from '../facturama/facturama.module.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [CacheModule, FacturamaModule, StorageModule],
  controllers: [BillingController],
  providers: [BillingService, CfdiService],
  exports: [BillingService, CfdiService],
})
export class BillingModule {}
