import { Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { GoogleAuthProvider } from '../../config/google-auth.provider.js';

@Module({
  providers: [StorageService, GoogleAuthProvider],
  exports: [StorageService],
})
export class StorageModule {}
