import { Module } from '@nestjs/common';
import { ErrorsController } from './errors.controller.js';
import { ErrorsService } from './errors.service.js';
import { CacheModule } from '../cache/cache.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [CacheModule, AuthModule],
  controllers: [ErrorsController],
  providers: [ErrorsService],
  exports: [ErrorsService],
})
export class ErrorsModule {}
