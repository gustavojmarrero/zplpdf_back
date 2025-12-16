import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import appConfig from './config/app.config.js';
import { GoogleAuthProvider } from './config/google-auth.provider.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    AuthModule,
    UsersModule,
    PaymentsModule,
    BillingModule,
    WebhooksModule,
    ContactModule,
    CronModule,
    ZplModule,
  ],
  controllers: [AppController],
  providers: [AppService, GoogleAuthProvider],
  exports: [GoogleAuthProvider],
})
export class AppModule {}
