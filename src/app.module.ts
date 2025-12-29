import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ZplModule } from './modules/zpl/zpl.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';
import { ContactModule } from './modules/contact/contact.module.js';
import { CronModule } from './modules/cron/cron.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { ErrorsModule } from './modules/errors/errors.module.js';
import { EmailModule } from './modules/email/email.module.js';
import appConfig from './config/app.config.js';
import { GoogleAuthProvider } from './config/google-auth.provider.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    // Rate limiting global: 100 requests por minuto por IP
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minuto
        limit: 100, // 100 requests
      },
    ]),
    AuthModule,
    UsersModule,
    PaymentsModule,
    BillingModule,
    WebhooksModule,
    ContactModule,
    CronModule,
    ZplModule,
    AdminModule,
    ErrorsModule,
    EmailModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    GoogleAuthProvider,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
  exports: [GoogleAuthProvider],
})
export class AppModule {}
