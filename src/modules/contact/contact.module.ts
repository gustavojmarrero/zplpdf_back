import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller.js';
import { ContactService } from './contact.service.js';
import { CacheModule } from '../cache/cache.module.js';

@Module({
  imports: [CacheModule],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
