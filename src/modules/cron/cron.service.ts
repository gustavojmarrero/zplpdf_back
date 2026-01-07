import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';
import { PeriodCalculatorService } from '../../common/services/period-calculator.service.js';
import { ExchangeRateService } from '../admin/services/exchange-rate.service.js';
import { ExpenseService } from '../admin/services/expense.service.js';
import { GoalsService } from '../admin/services/goals.service.js';
import { GA4Service } from '../analytics/ga4.service.js';

export interface ResetUsageResult {
  resetCount: number;
  executedAt: Date;
}

export interface CleanupErrorsResult {
  deletedCount: number;
  executedAt: Date;
}

export interface UpdateExchangeRateResult {
  success: boolean;
  rate?: number;
  source?: string;
  executedAt: Date;
}

export interface GenerateRecurringExpensesResult {
  generated: number;
  executedAt: Date;
}

export interface UpdateGoalsResult {
  month: string;
  updated: boolean;
  executedAt: Date;
}

export interface CheckInactiveUsersResult {
  notified7Days: number;
  notified30Days: number;
  executedAt: Date;
}

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly periodCalculatorService: PeriodCalculatorService,
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRateService: ExchangeRateService,
    @Inject(forwardRef(() => ExpenseService))
    private readonly expenseService: ExpenseService,
    @Inject(forwardRef(() => GoalsService))
    private readonly goalsService: GoalsService,
    private readonly ga4Service: GA4Service,
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
          const newPeriodInfo = this.periodCalculatorService.calculateCurrentPeriod(user);

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

  /**
   * Delete errors older than 90 days
   */
  async cleanupOldErrors(): Promise<CleanupErrorsResult> {
    this.logger.log('Starting error cleanup cron job...');

    try {
      const retentionDays = 90;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const deletedCount = await this.firestoreService.deleteOldErrors(cutoffDate);

      this.logger.log(`Error cleanup completed. Deleted ${deletedCount} error(s) older than ${retentionDays} days.`);

      return {
        deletedCount,
        executedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error in cleanup cron job: ${error.message}`);
      throw error;
    }
  }

  /**
   * Actualiza el tipo de cambio USD/MXN desde Banxico
   * Ejecutar diariamente a las 6:00 AM (GMT-6)
   */
  async updateExchangeRate(): Promise<UpdateExchangeRateResult> {
    this.logger.log('Starting exchange rate update cron job...');

    try {
      const result = await this.exchangeRateService.updateRateCache(this.firestoreService);

      this.logger.log(`Exchange rate update completed: ${result.rate} (${result.source})`);

      return {
        success: true,
        rate: result.rate,
        source: result.source,
        executedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error in exchange rate update cron job: ${error.message}`);
      return {
        success: false,
        executedAt: new Date(),
      };
    }
  }

  /**
   * Genera gastos recurrentes que vencen hoy
   * Ejecutar diariamente a las 00:05 (GMT-6)
   */
  async generateRecurringExpenses(): Promise<GenerateRecurringExpensesResult> {
    this.logger.log('Starting recurring expenses generation cron job...');

    try {
      const result = await this.expenseService.generateRecurringExpenses();

      this.logger.log(`Recurring expenses generation completed. Generated ${result.generated} expense(s).`);

      return {
        generated: result.generated,
        executedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error in recurring expenses cron job: ${error.message}`);
      throw error;
    }
  }

  /**
   * Actualiza el progreso de los objetivos mensuales
   * Ejecutar cada hora
   */
  async updateGoals(): Promise<UpdateGoalsResult> {
    this.logger.log('Starting goals update cron job...');

    try {
      await this.goalsService.updateActuals();
      const month = new Date().toISOString().slice(0, 7);

      this.logger.log(`Goals update completed for ${month}`);

      return {
        month,
        updated: true,
        executedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error in goals update cron job: ${error.message}`);
      return {
        month: new Date().toISOString().slice(0, 7),
        updated: false,
        executedAt: new Date(),
      };
    }
  }

  /**
   * Check for inactive users and send GA4 events
   * Ejecutar diariamente a las 08:00 (GMT-6)
   */
  async checkInactiveUsers(): Promise<CheckInactiveUsersResult> {
    this.logger.log('Starting inactive users check cron job...');

    let notified7Days = 0;
    let notified30Days = 0;

    try {
      // Check 7-day inactive users
      const inactive7Days = await this.firestoreService.getInactiveUsers(7, 'notifiedInactive7Days');
      this.logger.log(`Found ${inactive7Days.length} users inactive for 7 days`);

      for (const user of inactive7Days) {
        try {
          // Send GA4 event
          await this.ga4Service.trackInactivity({
            userId: user.id,
            userEmail: user.email,
            daysInactive: 7,
            userPlan: user.plan,
            lastActivityAt: user.lastActivityAt,
          });

          // Mark as notified
          await this.firestoreService.markUserInactiveNotified(user.id, 'notifiedInactive7Days');
          notified7Days++;
        } catch (error) {
          this.logger.error(`Error processing 7-day inactive user ${user.id}: ${error.message}`);
        }
      }

      // Check 30-day inactive users
      const inactive30Days = await this.firestoreService.getInactiveUsers(30, 'notifiedInactive30Days');
      this.logger.log(`Found ${inactive30Days.length} users inactive for 30 days`);

      for (const user of inactive30Days) {
        try {
          // Send GA4 event
          await this.ga4Service.trackInactivity({
            userId: user.id,
            userEmail: user.email,
            daysInactive: 30,
            userPlan: user.plan,
            lastActivityAt: user.lastActivityAt,
          });

          // Mark as notified
          await this.firestoreService.markUserInactiveNotified(user.id, 'notifiedInactive30Days');
          notified30Days++;
        } catch (error) {
          this.logger.error(`Error processing 30-day inactive user ${user.id}: ${error.message}`);
        }
      }

      this.logger.log(
        `Inactive users check completed. Notified: ${notified7Days} (7 days), ${notified30Days} (30 days)`,
      );

      return {
        notified7Days,
        notified30Days,
        executedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error in inactive users check cron job: ${error.message}`);
      return {
        notified7Days,
        notified30Days,
        executedAt: new Date(),
      };
    }
  }
}
