import { Global, Module } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CacheModule } from '../cache/cache.module.js';

@Global()
@Module({
  imports: [CacheModule],
  providers: [FirebaseAdminService, FirebaseAuthGuard],
  exports: [FirebaseAdminService, FirebaseAuthGuard],
})
export class AuthModule {}
