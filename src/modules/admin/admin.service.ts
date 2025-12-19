import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { BillingService } from '../billing/billing.service.js';
import { PeriodCalculatorService } from '../../common/services/period-calculator.service.js';
import { DEFAULT_PLAN_LIMITS } from '../../common/interfaces/user.interface.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';
import type { AdminUserData } from '../../common/decorators/admin-user.decorator.js';
import type { AdminMetricsResponseDto } from './dto/admin-metrics.dto.js';
import type {
  GetUsersQueryDto,
  AdminUsersResponseDto,
  AdminUserDetailResponseDto,
  UpdateUserPlanDto,
  UpdateUserPlanResponseDto,
} from './dto/admin-users.dto.js';
import type { GetConversionsQueryDto, AdminConversionsResponseDto } from './dto/admin-conversions.dto.js';
import type { GetErrorsQueryDto, AdminErrorsResponseDto } from './dto/admin-errors.dto.js';
import type { AdminPlanUsageResponseDto } from './dto/admin-plan-usage.dto.js';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private stripe: Stripe | null = null;

  // Caché de métricas del dashboard (5 minutos)
  private metricsCache: { data: AdminMetricsResponseDto; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly billingService: BillingService,
    private readonly configService: ConfigService,
    private readonly periodCalculatorService: PeriodCalculatorService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeSecretKey) {
      this.stripe = new Stripe(stripeSecretKey);
    }
  }

  async getDashboardMetrics(): Promise<AdminMetricsResponseDto> {
    // Verificar caché
    if (this.metricsCache && Date.now() - this.metricsCache.timestamp < this.CACHE_TTL_MS) {
      this.logger.log('Returning cached dashboard metrics');
      return this.metricsCache.data;
    }

    this.logger.log('Fetching dashboard metrics (cache miss)');

    try {
      // Fetch all metrics in parallel
      const [
        totalUsers,
        usersByPlan,
        activeToday,
        activeWeek,
        activeMonth,
        recentRegistrations,
        conversionStatsDay,
        conversionStatsWeek,
        conversionStatsMonth,
        conversionTrend,
        errorStats,
        usersNearLimit,
        planDistribution,
        upgradeOpportunities,
      ] = await Promise.all([
        this.firestoreService.getUsersCount(),
        this.firestoreService.getUsersByPlan(),
        this.firestoreService.getActiveUsers('day'),
        this.firestoreService.getActiveUsers('week'),
        this.firestoreService.getActiveUsers('month'),
        this.firestoreService.getRecentRegistrations(10),
        this.firestoreService.getConversionStats('day'),
        this.firestoreService.getConversionStats('week'),
        this.firestoreService.getConversionStats('month'),
        this.firestoreService.getConversionTrend(8),
        this.firestoreService.getErrorStats(),
        this.firestoreService.getUsersNearLimit(80),
        this.firestoreService.getPlanDistribution(),
        this.firestoreService.getUpgradeOpportunities(),
      ]);

      // Calculate success/failure rates
      const totalConversions = conversionStatsMonth.summary.totalPdfs;
      const successRate = totalConversions > 0
        ? Math.round((conversionStatsMonth.summary.successCount / totalConversions) * 1000) / 10
        : 100;
      const failureRate = Math.round((100 - successRate) * 10) / 10;

      // Transform trend data
      const trend = conversionTrend.map((item) => ({
        date: item.date,
        count: item.pdfs,
        labels: item.labels,
        failures: item.failures,
      }));

      // Transform recent errors
      const recentErrors = errorStats.recentErrors.map((error) => ({
        id: error.id,
        type: error.type,
        code: error.code,
        message: error.message,
        userId: error.userId,
        userEmail: error.userEmail,
        jobId: error.jobId,
        timestamp: error.createdAt,
        severity: error.severity,
        context: error.context,
      }));

      // Transform recent registrations
      const formattedRegistrations = recentRegistrations.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        plan: user.plan,
        createdAt: user.createdAt,
      }));

      // Transform users near limit
      const formattedUsersNearLimit = usersNearLimit.map((user) => ({
        id: user.id,
        email: user.email,
        plan: user.plan,
        pdfCount: user.pdfCount,
        pdfLimit: user.pdfLimit,
        percentUsed: user.percentUsed,
        periodEnd: user.periodEnd,
      }));

      const result: AdminMetricsResponseDto = {
        success: true,
        data: {
          users: {
            total: totalUsers,
            activeToday,
            activeWeek,
            activeMonth,
            byPlan: usersByPlan,
            recentRegistrations: formattedRegistrations,
          },
          conversions: {
            pdfsToday: conversionStatsDay.summary.totalPdfs,
            pdfsWeek: conversionStatsWeek.summary.totalPdfs,
            pdfsMonth: conversionStatsMonth.summary.totalPdfs,
            labelsTotal: conversionStatsMonth.summary.totalLabels,
            successRate,
            failureRate,
            trend,
          },
          errors: {
            recentErrors,
            byType: errorStats.byType,
            criticalCount: errorStats.criticalCount,
          },
          planUsage: {
            distribution: planDistribution.distribution as any,
            usersNearLimit: formattedUsersNearLimit,
            usersExceedingFrequently: [], // Would need additional tracking
            upgradeOpportunities,
          },
        },
        generatedAt: new Date(),
      };

      // Guardar en caché
      this.metricsCache = { data: result, timestamp: Date.now() };

      return result;
    } catch (error) {
      this.logger.error(`Error fetching dashboard metrics: ${error.message}`);
      throw error;
    }
  }

  async getUsers(query: GetUsersQueryDto): Promise<AdminUsersResponseDto> {
    this.logger.log('Fetching users list');

    try {
      const result = await this.firestoreService.getUsersPaginated({
        page: query.page,
        limit: query.limit,
        plan: query.plan,
        search: query.search,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
        dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      });

      // Recalculate usage for each user using correct period
      const usersWithCorrectUsage = await Promise.all(
        result.users.map(async (user) => {
          try {
            const periodInfo = await this.periodCalculatorService.calculateCurrentPeriod({
              id: user.id,
              plan: user.plan as PlanType,
              createdAt: user.createdAt,
            });
            const usage = await this.firestoreService.getOrCreateUsageWithPeriod(user.id, periodInfo);
            return {
              ...user,
              usage: {
                pdfCount: usage.pdfCount,
                labelCount: usage.labelCount,
              },
            };
          } catch {
            // Keep original usage on error
            return user;
          }
        }),
      );

      return {
        success: true,
        data: {
          ...result,
          users: usersWithCorrectUsage,
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching users: ${error.message}`);
      throw error;
    }
  }

  async getConversions(query: GetConversionsQueryDto): Promise<AdminConversionsResponseDto> {
    this.logger.log('Fetching conversions stats');

    try {
      const startDate = query.startDate ? new Date(query.startDate) : undefined;
      const endDate = query.endDate ? new Date(query.endDate) : undefined;

      const [conversionStats, trend, topUsers] = await Promise.all([
        this.firestoreService.getConversionStats(query.period, startDate, endDate),
        this.firestoreService.getConversionTrend(query.period === 'day' ? 1 : query.period === 'week' ? 7 : 30),
        this.firestoreService.getTopUsers(10),
      ]);

      // Transform trend data
      const formattedTrend = trend.map((item) => ({
        date: item.date,
        pdfs: item.pdfs,
        labels: item.labels,
        failures: item.failures,
      }));

      return {
        success: true,
        data: {
          summary: conversionStats.summary,
          trend: formattedTrend,
          byPlan: conversionStats.byPlan as any,
          topUsers,
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching conversions: ${error.message}`);
      throw error;
    }
  }

  async getErrors(query: GetErrorsQueryDto): Promise<AdminErrorsResponseDto> {
    this.logger.log('Fetching errors log');

    try {
      const result = await this.firestoreService.getErrorLogs({
        page: query.page,
        limit: query.limit,
        severity: query.severity,
        type: query.type,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
        userId: query.userId,
      });

      // Transform errors
      const errors = result.errors.map((error) => ({
        id: error.id,
        type: error.type,
        code: error.code,
        message: error.message,
        userId: error.userId,
        userEmail: error.userEmail,
        jobId: error.jobId,
        timestamp: error.createdAt,
        severity: error.severity,
        context: error.context,
      }));

      return {
        success: true,
        data: {
          errors,
          summary: {
            total: result.summary.total,
            bySeverity: result.summary.bySeverity as any,
            byType: result.summary.byType,
          },
          pagination: result.pagination,
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching errors: ${error.message}`);
      throw error;
    }
  }

  async getPlanUsage(): Promise<AdminPlanUsageResponseDto> {
    this.logger.log('Fetching plan usage');

    try {
      const [usersNearLimit, planDistribution, upgradeOpportunities] = await Promise.all([
        this.firestoreService.getUsersNearLimit(80),
        this.firestoreService.getPlanDistribution(),
        this.firestoreService.getUpgradeOpportunities(),
      ]);

      // Transform users near limit
      const formattedUsersNearLimit = usersNearLimit.map((user) => ({
        id: user.id,
        email: user.email,
        plan: user.plan,
        pdfCount: user.pdfCount,
        pdfLimit: user.pdfLimit,
        percentUsed: user.percentUsed,
        periodEnd: user.periodEnd,
      }));

      return {
        success: true,
        data: {
          distribution: planDistribution.distribution as any,
          usersNearLimit: formattedUsersNearLimit,
          usersExceedingFrequently: [], // Would need additional tracking
          upgradeOpportunities,
          conversionRates: planDistribution.conversionRates,
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching plan usage: ${error.message}`);
      throw error;
    }
  }

  // ==================== User Detail ====================

  async getUserDetail(userId: string): Promise<AdminUserDetailResponseDto> {
    this.logger.log(`Fetching user detail: ${userId}`);

    // 1. Get user data
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new NotFoundException({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: `Usuario con ID ${userId} no encontrado`,
        },
      });
    }

    // 2. Get current usage using the correct period calculation
    const periodInfo = await this.periodCalculatorService.calculateCurrentPeriod({
      id: user.id,
      plan: user.plan,
      createdAt: user.createdAt,
      stripeSubscriptionId: user.stripeSubscriptionId,
    });
    const currentUsage = await this.firestoreService.getOrCreateUsageWithPeriod(userId, periodInfo);
    const planLimits = user.planLimits || DEFAULT_PLAN_LIMITS[user.plan];
    const pdfLimit = planLimits.maxPdfsPerMonth;
    const percentUsed = pdfLimit > 0 ? Math.round((currentUsage.pdfCount / pdfLimit) * 100) : 0;

    // 3. Get usage history (last 30 days)
    const usageHistory = await this.firestoreService.getUserUsageHistory(userId, 30);

    // 4. Get subscription info if user has Stripe subscription
    let subscription: {
      status: string;
      currentPeriodStart: string;
      currentPeriodEnd: string;
      stripeCustomerId?: string;
      cancelAtPeriodEnd?: boolean;
    } | undefined;

    if (user.stripeSubscriptionId) {
      try {
        const stripeSubscription = await this.billingService.getSubscription(userId);
        if (stripeSubscription) {
          subscription = {
            status: stripeSubscription.status,
            currentPeriodStart: new Date(stripeSubscription.currentPeriodStart * 1000).toISOString(),
            currentPeriodEnd: stripeSubscription.currentPeriodEnd
              ? new Date(stripeSubscription.currentPeriodEnd * 1000).toISOString()
              : new Date().toISOString(),
            stripeCustomerId: user.stripeCustomerId,
            cancelAtPeriodEnd: stripeSubscription.cancelAtPeriodEnd,
          };
        }
      } catch (error) {
        this.logger.warn(`Could not fetch Stripe subscription for user ${userId}: ${error.message}`);
      }
    }

    // 5. Get last activity from conversion history
    let lastActiveAt: string | undefined;
    try {
      const history = await this.firestoreService.getUserConversionHistory(userId, 1, 0);
      if (history.length > 0) {
        lastActiveAt =
          history[0].createdAt instanceof Date
            ? history[0].createdAt.toISOString()
            : new Date(history[0].createdAt).toISOString();
      }
    } catch {
      // Ignore errors
    }

    return {
      success: true,
      data: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        plan: user.plan,
        usage: {
          pdfCount: currentUsage.pdfCount,
          labelCount: currentUsage.labelCount,
          pdfLimit,
          percentUsed,
        },
        usageHistory,
        subscription,
        createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : new Date(user.createdAt).toISOString(),
        lastActiveAt,
      },
    };
  }

  // ==================== Update User Plan ====================

  async updateUserPlan(
    userId: string,
    dto: UpdateUserPlanDto,
    adminUser: AdminUserData,
  ): Promise<UpdateUserPlanResponseDto> {
    this.logger.log(`Admin ${adminUser.email} changing plan for user ${userId} to ${dto.newPlan}`);

    const warnings: string[] = [];

    // 1. Get current user
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new NotFoundException({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: `Usuario con ID ${userId} no encontrado`,
        },
      });
    }

    const previousPlan = user.plan;

    // 2. Validate plan is different
    if (previousPlan === dto.newPlan) {
      throw new BadRequestException({
        success: false,
        error: {
          code: 'SAME_PLAN',
          message: `El usuario ya tiene el plan ${dto.newPlan}`,
        },
      });
    }

    // 3. Handle Stripe subscription if exists and downgrading
    let stripeCanceled = false;
    const isDowngrade = this.isPlanDowngrade(previousPlan, dto.newPlan);

    if (user.stripeSubscriptionId && isDowngrade) {
      // Automatically cancel Stripe subscription when downgrading
      try {
        if (this.stripe) {
          await this.stripe.subscriptions.cancel(user.stripeSubscriptionId);
          stripeCanceled = true;
          this.logger.log(`Stripe subscription ${user.stripeSubscriptionId} canceled for user ${userId}`);
        } else {
          warnings.push('Stripe no está configurado. No se pudo cancelar la suscripción automáticamente.');
        }
      } catch (error) {
        warnings.push(`No se pudo cancelar la suscripción Stripe: ${error.message}`);
        this.logger.error(`Failed to cancel Stripe subscription: ${error.message}`);
      }
    }

    // 4. Update plan in Firestore
    const newPlanLimits = DEFAULT_PLAN_LIMITS[dto.newPlan as PlanType];

    await this.firestoreService.updateUser(userId, {
      plan: dto.newPlan as PlanType,
      planLimits: newPlanLimits,
      // Clear Stripe subscription ID if canceled
      ...(stripeCanceled ? { stripeSubscriptionId: null } : {}),
    });

    // 5. Save to admin audit log
    await this.firestoreService.saveAdminAuditLog({
      adminEmail: adminUser.email,
      adminUid: adminUser.uid,
      action: 'update_user_plan',
      endpoint: `/admin/users/${userId}/plan`,
      requestParams: {
        userId,
        previousPlan,
        newPlan: dto.newPlan,
        reason: dto.reason,
        stripeCanceled,
      },
    });

    const effectiveAt = new Date().toISOString();

    return {
      success: true,
      data: {
        userId,
        previousPlan,
        newPlan: dto.newPlan,
        effectiveAt,
        stripeCanceled,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    };
  }

  private isPlanDowngrade(currentPlan: PlanType, newPlan: string): boolean {
    const planOrder: Record<string, number> = { free: 0, pro: 1, enterprise: 2 };
    return planOrder[newPlan] < planOrder[currentPlan];
  }
}
