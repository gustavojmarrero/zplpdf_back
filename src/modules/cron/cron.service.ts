import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';

export interface ResetUsageResult {
  resetCount: number;
  executedAt: Date;
}

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(private readonly firestoreService: FirestoreService) {}

  async resetExpiredUsage(): Promise<ResetUsageResult> {
    this.logger.log('Starting usage reset cron job...');

    try {
      const resetCount = await this.firestoreService.resetExpiredUsage();

      this.logger.log(`Usage reset completed. Reset ${resetCount} user(s).`);

      return {
        resetCount,
        executedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error in usage reset cron job: ${error.message}`);
      throw error;
    }
  }
}
