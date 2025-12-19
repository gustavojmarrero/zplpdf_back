import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [CacheModule, AuthModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
