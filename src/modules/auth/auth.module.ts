import { Global, Module } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';

@Global()
@Module({
  providers: [FirebaseAdminService, FirebaseAuthGuard],
  exports: [FirebaseAdminService, FirebaseAuthGuard],
})
export class AuthModule {}
