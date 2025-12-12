import { Module, forwardRef } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { ZplModule } from '../zpl/zpl.module.js';

@Module({
  imports: [CacheModule, forwardRef(() => ZplModule)],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
