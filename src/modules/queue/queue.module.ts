import { Module } from '@nestjs/common';
import { CloudTasksService } from './cloud-tasks.service.js';
import { GoogleAuthProvider } from '../../config/google-auth.provider.js';

@Module({
  providers: [CloudTasksService, GoogleAuthProvider],
  exports: [CloudTasksService],
})
export class QueueModule {}
