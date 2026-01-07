import { Module, forwardRef } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { ZplModule } from '../zpl/zpl.module.js';
import { PeriodModule } from '../../common/services/period.module.js';
import { AdminModule } from '../admin/admin.module.js';
import { EmailModule } from '../email/email.module.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [
    CacheModule,
    forwardRef(() => ZplModule),
    PeriodModule,
    forwardRef(() => AdminModule),
    forwardRef(() => EmailModule),
    StorageModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
