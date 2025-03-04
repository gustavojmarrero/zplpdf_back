import { Module } from '@nestjs/common';
import { ZplToPdfConverter } from './zpl-to-pdf.util.js';

@Module({
  providers: [ZplToPdfConverter],
  exports: [ZplToPdfConverter],
})
export class UtilsModule {} 