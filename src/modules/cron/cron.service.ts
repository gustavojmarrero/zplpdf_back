import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';
import { PeriodCalculatorService } from '../../common/services/period-calculator.service.js';

export interface ResetUsageResult {
  resetCount: number;
  executedAt: Date;
}

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly periodCalculatorService: PeriodCalculatorService,
  ) {}

  async resetExpiredUsage(): Promise<ResetUsageResult> {
    this.logger.log('Starting usage reset cron job...');

    try {
      const now = new Date();
      let resetCount = 0;

      // Obtener todos los usos expirados
      const expiredUsages = await this.firestoreService.getExpiredUsages(now);
      this.logger.log(`Found ${expiredUsages.length} expired usage(s) to process`);

      for (const usage of expiredUsages) {
        try {
          // Obtener el usuario para determinar su plan
          const user = await this.firestoreService.getUserById(usage.userId);

          if (!user) {
            this.logger.warn(`User not found for expired usage: ${usage.odId}`);
            continue;
          }

          // Calcular nuevo período basado en el plan del usuario
          const newPeriodInfo = await this.periodCalculatorService.calculateCurrentPeriod(user);

          // Crear nuevo documento de uso con el período calculado
          await this.firestoreService.getOrCreateUsageWithPeriod(user.id, newPeriodInfo);

          this.logger.log(`Reset usage for user ${user.id}: ${usage.odId} -> ${newPeriodInfo.periodId}`);
          resetCount++;
        } catch (userError) {
          this.logger.error(`Error processing user ${usage.userId}: ${userError.message}`);
        }
      }

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
