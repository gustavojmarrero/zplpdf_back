import { Module, forwardRef } from '@nestjs/common';
import { PeriodCalculatorService } from './period-calculator.service.js';
import { BillingModule } from '../../modules/billing/billing.module.js';

@Module({
  imports: [forwardRef(() => BillingModule)],
  providers: [PeriodCalculatorService],
  exports: [PeriodCalculatorService],
})
export class PeriodModule {}
