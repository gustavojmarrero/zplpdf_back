import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from './email.service.js';
import { EmailController } from './email.controller.js';
import { EmailTemplatesController } from './email-templates.controller.js';
import { CacheModule } from '../cache/cache.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => CacheModule),
    forwardRef(() => AuthModule),
  ],
  controllers: [EmailController, EmailTemplatesController],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
