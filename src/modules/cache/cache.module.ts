import { Module } from '@nestjs/common';
import { FirestoreService } from './firestore.service.js';
import { GoogleAuthProvider } from '../../config/google-auth.provider.js';

@Module({
  providers: [FirestoreService, GoogleAuthProvider],
  exports: [FirestoreService],
})
export class CacheModule {}
