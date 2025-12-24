import { Module, forwardRef } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { PeriodModule } from '../../common/services/period.module.js';
import { ZplModule } from '../zpl/zpl.module.js';
// Finance services
import { ExchangeRateService } from './services/exchange-rate.service.js';
import { FinanceService } from './services/finance.service.js';
import { ExpenseService } from './services/expense.service.js';
import { GeoService } from './services/geo.service.js';
import { GoalsService } from './services/goals.service.js';

@Module({
  imports: [
    CacheModule,
    AuthModule,
    BillingModule,
    PeriodModule,
    forwardRef(() => ZplModule),
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    ExchangeRateService,
    FinanceService,
    ExpenseService,
    GeoService,
    GoalsService,
  ],
  exports: [
    AdminService,
    ExchangeRateService,
    FinanceService,
    ExpenseService,
    GeoService,
    GoalsService,
  ],
})
export class AdminModule {}
