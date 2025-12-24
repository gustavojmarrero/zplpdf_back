import { Module, forwardRef } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { PeriodModule } from '../../common/services/period.module.js';
import { ZplModule } from '../zpl/zpl.module.js';

@Module({
  imports: [
    CacheModule,
    AuthModule,
    BillingModule,
    PeriodModule,
    forwardRef(() => ZplModule),
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
