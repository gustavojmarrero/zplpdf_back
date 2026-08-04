import { Module } from '@nestjs/common';
import { FacturamaService } from './facturama.service.js';

@Module({
  providers: [FacturamaService],
  exports: [FacturamaService],
})
export class FacturamaModule {}
