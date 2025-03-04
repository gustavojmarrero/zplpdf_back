import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ZplModule } from './modules/zpl/zpl.module.js';
import appConfig from './config/app.config.js';
import { GoogleAuthProvider } from './config/google-auth.provider.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
    }),
    ZplModule,
  ],
  controllers: [AppController],
  providers: [AppService, GoogleAuthProvider],
  exports: [GoogleAuthProvider],
})
export class AppModule {}
