import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
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

export interface MigrateSubscriptionPeriodsResult {
  updated: number;
  skipped: number;
  errors: number;
  executedAt: Date;
}

export interface ResetUSCountriesResult {
  updated: number;
  executedAt: Date;
}

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly firestoreService: FirestoreService,
    private readonly periodCalculatorService: PeriodCalculatorService,
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRateService: ExchangeRateService,
    @Inject(forwardRef(() => ExpenseService))
    private readonly expenseService: ExpenseService,
    @Inject(forwardRef(() => GoalsService))
    private readonly goalsService: GoalsService,
    private readonly ga4Service: GA4Service,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, { apiVersion: '2025-11-17.clover' as Stripe.LatestApiVersion });
    }
  }

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

  /**
   * Migrate subscription periods from Stripe to Firestore
   * One-time migration for existing PRO users
   */
  async migrateSubscriptionPeriods(): Promise<MigrateSubscriptionPeriodsResult> {
    this.logger.log('Starting subscription periods migration...');

    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    try {
      // Get all PRO users
      const allUsers = await this.firestoreService.getAllUsers();
      const proUsers = allUsers.filter(u => u.plan === 'pro' || u.plan === 'promax');

      this.logger.log(`Found ${proUsers.length} PRO/Promax users`);

      for (const user of proUsers) {
        // Skip users without subscription ID
        if (!user.stripeSubscriptionId) {
          this.logger.warn(`User ${user.email} has no stripeSubscriptionId`);
          skipped++;
          continue;
        }

        // Skip users who already have period data
        if (user.subscriptionPeriodStart && user.subscriptionPeriodEnd) {
          this.logger.debug(`User ${user.email} already has period data`);
          skipped++;
          continue;
        }

        try {
          // Fetch subscription from Stripe
          const subscription = await this.stripe.subscriptions.retrieve(user.stripeSubscriptionId);

          // Extract period from subscription items
          const periodStart = (subscription as unknown as { current_period_start: number }).current_period_start;
          const periodEnd = (subscription as unknown as { current_period_end: number }).current_period_end;

          if (!periodStart || !periodEnd) {
            this.logger.warn(`User ${user.email}: No period data in subscription`);
            skipped++;
            continue;
          }

          // Update user in Firestore
          await this.firestoreService.updateUser(user.id, {
            subscriptionPeriodStart: new Date(periodStart * 1000),
            subscriptionPeriodEnd: new Date(periodEnd * 1000),
          });

          const startDate = new Date(periodStart * 1000).toISOString().split('T')[0];
          const endDate = new Date(periodEnd * 1000).toISOString().split('T')[0];
          this.logger.log(`✅ ${user.email}: ${startDate} → ${endDate}`);
          updated++;
        } catch (error) {
          this.logger.error(`❌ ${user.email}: ${error.message}`);
          errors++;
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      this.logger.log(`Migration completed: ${updated} updated, ${skipped} skipped, ${errors} errors`);

      return {
        updated,
        skipped,
        errors,
        executedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error in migration: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reset users with country "US" to "unknown"
   * One-time migration to fix incorrectly assigned US countries
   * Issue #69: https://github.com/gustavojmarrero/zplpdf_front/issues/69
   *
   * These users were incorrectly detected as US because:
   * - 49 users have city "Ashburn" (AWS/Cloudflare datacenter in Virginia)
   * - 107 users have no city (detected via server IP, not user IP)
   */
  async resetUSCountries(): Promise<ResetUSCountriesResult> {
    this.logger.log('Starting US countries reset migration...');

    let updated = 0;

    try {
      // Get all users with country "US" that have Ashburn or no city
      const allUsers = await this.firestoreService.getAllUsers();
      const usUsers = allUsers.filter(
        u => u.country === 'US' && (!u.city || u.city === 'Ashburn'),
      );

      this.logger.log(`Found ${usUsers.length} US users with Ashburn or no city (to be reset)`);

      // Log city distribution for documentation
      const cityStats = new Map<string, number>();
      for (const user of usUsers) {
        const city = user.city || 'sin ciudad';
        cityStats.set(city, (cityStats.get(city) || 0) + 1);
      }
      this.logger.log(`City distribution: ${JSON.stringify(Object.fromEntries(cityStats))}`);

      for (const user of usUsers) {
        try {
          await this.firestoreService.updateUser(user.id, {
            country: 'unknown',
            city: null,
            countrySource: null,
            countryDetectedAt: null,
          });

          this.logger.log(`✅ Reset country for user ${user.email}: US → unknown`);
          updated++;
        } catch (error) {
          this.logger.error(`❌ Error resetting country for ${user.email}: ${error.message}`);
        }
      }

      this.logger.log(`US countries reset completed: ${updated} users updated`);

      return {
        updated,
        executedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error in US countries reset: ${error.message}`);
      throw error;
    }
  }
}
