import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { BillingService } from '../billing/billing.service.js';
import { PeriodCalculatorService } from '../../common/services/period-calculator.service.js';
import { LabelaryAnalyticsService } from '../zpl/services/labelary-analytics.service.js';
import { DEFAULT_PLAN_LIMITS } from '../../common/interfaces/user.interface.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';
import type { AdminUserData } from '../../common/decorators/admin-user.decorator.js';
import type { AdminMetricsResponseDto } from './dto/admin-metrics.dto.js';
import type {
  LabelaryStatsResponse,
  LabelaryMetricsResponse,
} from '../zpl/interfaces/labelary-analytics.interface.js';
import { LabelaryQueueService } from '../zpl/services/labelary-queue.service.js';
// Finance services
import { FinanceService } from './services/finance.service.js';
import { ExpenseService, type CreateExpenseDto, type UpdateExpenseDto, type ExpenseFilters } from './services/expense.service.js';
import { GeoService } from './services/geo.service.js';
import { GoalsService, type SetGoalsDto } from './services/goals.service.js';
import type {
  GetUsersQueryDto,
  AdminUsersResponseDto,
  AdminUserDetailResponseDto,
  UpdateUserPlanDto,
  UpdateUserPlanResponseDto,
} from './dto/admin-users.dto.js';
import type { GetConversionsQueryDto, AdminConversionsResponseDto, GetConversionsListQueryDto, AdminConversionsListResponseDto } from './dto/admin-conversions.dto.js';
import type {
  GetErrorsQueryDto,
  AdminErrorsResponseDto,
  AdminErrorDetailResponseDto,
  UpdateErrorDto,
  UpdateErrorResponseDto,
  AdminErrorStatsResponseDto,
} from './dto/admin-errors.dto.js';
import type { AdminPlanUsageResponseDto } from './dto/admin-plan-usage.dto.js';
import type { GetPlanChangesQueryDto, AdminPlanChangesResponseDto } from './dto/admin-plan-changes.dto.js';
import type { GetConsumptionProjectionQueryDto, AdminConsumptionProjectionResponseDto } from './dto/admin-consumption-projection.dto.js';

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
    private readonly labelaryAnalyticsService: LabelaryAnalyticsService,
    private readonly labelaryQueueService: LabelaryQueueService,
    private readonly financeService: FinanceService,
    private readonly expenseService: ExpenseService,
    private readonly geoService: GeoService,
    private readonly goalsService: GoalsService,
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
        historicalTotals,
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
        this.firestoreService.getHistoricalTotals(),
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
            pdfsTotal: historicalTotals.pdfsTotal,
            labelsToday: conversionStatsDay.summary.totalLabels,
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
      // For pdfCount sorting, we need to handle it here after recalculating usage
      const needsMemorySort = query.sortBy === 'pdfCount' || query.sortBy === 'lastActiveAt';

      const result = await this.firestoreService.getUsersPaginated({
        page: needsMemorySort ? 1 : query.page,
        limit: needsMemorySort ? 10000 : query.limit, // Get all for memory sort
        plan: query.plan,
        search: query.search,
        sortBy: needsMemorySort ? 'createdAt' : query.sortBy, // Default sort in Firestore
        sortOrder: needsMemorySort ? 'desc' : query.sortOrder,
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

      let finalUsers = usersWithCorrectUsage;

      // Sort by pdfCount or lastActiveAt after recalculating usage
      if (needsMemorySort) {
        finalUsers.sort((a, b) => {
          let aVal: number;
          let bVal: number;

          if (query.sortBy === 'pdfCount') {
            aVal = a.usage.pdfCount;
            bVal = b.usage.pdfCount;
          } else {
            // lastActiveAt
            aVal = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
            bVal = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
          }

          if (query.sortOrder === 'asc') {
            return aVal - bVal;
          } else {
            return bVal - aVal;
          }
        });

        // Apply pagination after sorting
        const page = query.page || 1;
        const limit = query.limit || 20;
        const offset = (page - 1) * limit;
        const total = finalUsers.length;

        finalUsers = finalUsers.slice(offset, offset + limit);

        return {
          success: true,
          data: {
            users: finalUsers,
            pagination: {
              page,
              limit,
              total,
              totalPages: Math.ceil(total / limit),
            },
          },
        };
      }

      return {
        success: true,
        data: {
          ...result,
          users: finalUsers,
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

  async getConversionsList(query: GetConversionsListQueryDto): Promise<AdminConversionsListResponseDto> {
    this.logger.log('Fetching conversions list');

    try {
      const result = await this.firestoreService.getConversionsPaginated({
        page: query.page,
        limit: query.limit,
        userId: query.userId,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
        status: query.status,
      });

      // Transform conversions
      const conversions = result.conversions.map((conversion) => ({
        id: conversion.id,
        userId: conversion.userId,
        userEmail: conversion.userEmail,
        createdAt: conversion.createdAt instanceof Date
          ? conversion.createdAt.toISOString()
          : new Date(conversion.createdAt).toISOString(),
        labelCount: conversion.labelCount,
        labelSize: conversion.labelSize,
        status: conversion.status,
        outputFormat: conversion.outputFormat,
        fileUrl: conversion.fileUrl,
      }));

      return {
        success: true,
        data: {
          conversions,
          pagination: result.pagination,
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching conversions list: ${error.message}`);
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
        status: query.status,
        source: query.source,
        errorId: query.errorId,
      });

      // Transform errors with new fields
      const errors = result.errors.map((error) => ({
        id: error.id,
        errorId: error.errorId,
        type: error.type,
        code: error.code,
        message: error.message,
        userId: error.userId,
        userEmail: error.userEmail,
        jobId: error.jobId,
        createdAt: error.createdAt,
        updatedAt: error.updatedAt,
        severity: error.severity,
        status: error.status,
        source: error.source,
        notes: error.notes,
        resolvedAt: error.resolvedAt,
        url: error.url,
        stackTrace: error.stackTrace,
        userAgent: error.userAgent,
        context: error.context,
      }));

      return {
        success: true,
        data: {
          errors,
          summary: {
            total: result.summary.total,
            bySeverity: result.summary.bySeverity,
            byType: result.summary.byType,
            byStatus: result.summary.byStatus,
            bySource: result.summary.bySource,
          },
          pagination: result.pagination,
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching errors: ${error.message}`);
      throw error;
    }
  }

  async getErrorStats(): Promise<AdminErrorStatsResponseDto> {
    this.logger.log('Fetching error statistics');

    try {
      const stats = await this.firestoreService.getDetailedErrorStats(30);

      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error(`Error fetching error stats: ${error.message}`);
      throw error;
    }
  }

  async getErrorDetail(id: string): Promise<AdminErrorDetailResponseDto> {
    this.logger.log(`Fetching error detail: ${id}`);

    try {
      const error = await this.firestoreService.getErrorById(id);

      if (!error) {
        throw new NotFoundException(`Error not found: ${id}`);
      }

      return {
        success: true,
        data: {
          id: error.id,
          errorId: error.errorId,
          type: error.type,
          code: error.code,
          message: error.message,
          userId: error.userId,
          userEmail: error.userEmail,
          jobId: error.jobId,
          createdAt: error.createdAt,
          updatedAt: error.updatedAt,
          severity: error.severity,
          status: error.status,
          source: error.source,
          notes: error.notes,
          resolvedAt: error.resolvedAt,
          url: error.url,
          stackTrace: error.stackTrace,
          userAgent: error.userAgent,
          context: error.context,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Error fetching error detail: ${error.message}`);
      throw error;
    }
  }

  async updateError(
    id: string,
    dto: UpdateErrorDto,
    admin: AdminUserData,
  ): Promise<UpdateErrorResponseDto> {
    this.logger.log(`Updating error: ${id}`);

    try {
      const updatedError = await this.firestoreService.updateErrorLog(id, {
        status: dto.status,
        notes: dto.notes,
      });

      if (!updatedError) {
        throw new NotFoundException(`Error not found: ${id}`);
      }

      // Log admin action
      await this.firestoreService.saveAdminAuditLog({
        adminEmail: admin.email,
        adminUid: admin.uid,
        action: 'update_error',
        endpoint: `/admin/errors/${id}`,
        requestParams: {
          errorId: id,
          status: dto.status,
          notes: dto.notes ? '[UPDATED]' : undefined,
        },
      });

      return {
        success: true,
        data: {
          id: updatedError.id,
          errorId: updatedError.errorId,
          status: updatedError.status,
          notes: updatedError.notes,
          resolvedAt: updatedError.resolvedAt,
          updatedAt: updatedError.updatedAt,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Error updating error: ${error.message}`);
      throw error;
    }
  }

  async getPlanUsage(): Promise<AdminPlanUsageResponseDto> {
    this.logger.log('Fetching plan usage');

    try {
      const [usersNearLimit, usersNearLabelLimit, labelUsageDistribution, planDistribution, upgradeOpportunities] = await Promise.all([
        this.firestoreService.getUsersNearLimit(80),
        this.firestoreService.getUsersNearLabelLimit(80),
        this.firestoreService.getLabelUsageDistribution(),
        this.firestoreService.getPlanDistribution(),
        this.firestoreService.getUpgradeOpportunities(),
      ]);

      // Transform users near PDF limit
      const formattedUsersNearLimit = usersNearLimit.map((user) => ({
        id: user.id,
        email: user.email,
        plan: user.plan,
        pdfCount: user.pdfCount,
        pdfLimit: user.pdfLimit,
        percentUsed: user.percentUsed,
        periodEnd: user.periodEnd,
      }));

      // Transform users near label limit
      const formattedUsersNearLabelLimit = usersNearLabelLimit.map((user) => ({
        id: user.id,
        email: user.email,
        plan: user.plan,
        labelCount: user.labelCount,
        labelLimit: user.labelLimit,
        percentUsed: user.percentUsed,
        periodEnd: user.periodEnd,
      }));

      return {
        success: true,
        data: {
          distribution: planDistribution.distribution as any,
          usersNearLimit: formattedUsersNearLimit,
          usersNearLabelLimit: formattedUsersNearLabelLimit,
          labelUsageDistribution,
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

  async getPlanChanges(query: GetPlanChangesQueryDto): Promise<AdminPlanChangesResponseDto> {
    this.logger.log('Fetching plan changes history');

    try {
      const result = await this.firestoreService.getPlanChanges({
        page: query.page,
        limit: query.limit,
        userId: query.userId,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      });

      // Transform changes
      const changes = result.changes.map((change) => ({
        userId: change.userId,
        userEmail: change.userEmail,
        previousPlan: change.previousPlan,
        newPlan: change.newPlan,
        changedAt: change.changedAt instanceof Date
          ? change.changedAt.toISOString()
          : new Date(change.changedAt).toISOString(),
        reason: change.reason,
        changedBy: change.changedBy,
      }));

      return {
        success: true,
        data: {
          changes,
          pagination: result.pagination,
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching plan changes: ${error.message}`);
      throw error;
    }
  }

  async getConsumptionProjection(query: GetConsumptionProjectionQueryDto): Promise<AdminConsumptionProjectionResponseDto> {
    this.logger.log('Fetching consumption projection');

    try {
      const allProjections = await this.firestoreService.getConsumptionProjection();

      // Apply filters
      let filteredProjections = allProjections;

      if (query.plan) {
        filteredProjections = filteredProjections.filter((p) => p.plan === query.plan);
      }

      if (query.status) {
        filteredProjections = filteredProjections.filter((p) => p.status === query.status);
      }

      // Calculate summary from ALL projections (before status filter for accurate totals)
      const projectionsForSummary = query.plan
        ? allProjections.filter((p) => p.plan === query.plan)
        : allProjections;

      const summary = {
        critical: projectionsForSummary.filter((p) => p.status === 'critical').length,
        risk: projectionsForSummary.filter((p) => p.status === 'risk').length,
        normal: projectionsForSummary.filter((p) => p.status === 'normal').length,
        total: projectionsForSummary.length,
      };

      // Transform users
      const users = filteredProjections.map((p) => ({
        id: p.id,
        email: p.email,
        name: p.name,
        plan: p.plan,
        billingPeriodStart: p.billingPeriodStart instanceof Date
          ? p.billingPeriodStart.toISOString()
          : new Date(p.billingPeriodStart).toISOString(),
        billingPeriodEnd: p.billingPeriodEnd instanceof Date
          ? p.billingPeriodEnd.toISOString()
          : new Date(p.billingPeriodEnd).toISOString(),
        planLimit: p.planLimit,
        pdfsUsed: p.pdfsUsed,
        daysElapsed: p.daysElapsed,
        dailyRate: p.dailyRate,
        projectedDaysToExhaust: p.projectedDaysToExhaust,
        status: p.status,
      }));

      return {
        success: true,
        data: {
          users,
          summary,
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching consumption projection: ${error.message}`);
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

  // ==================== Simulación de Plan (Admin) ====================

  async simulatePlan(
    adminUid: string,
    plan: PlanType,
    durationHours: number = 24,
    adminUser: AdminUserData,
  ) {
    this.logger.log(`Admin ${adminUser.email} simulating plan ${plan} for ${durationHours}h`);

    // Verificar que el usuario admin existe
    const user = await this.firestoreService.getUserById(adminUid);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== 'admin') {
      throw new BadRequestException('Solo los administradores pueden simular planes');
    }

    // Calcular fecha de expiración
    const simulationExpiresAt = new Date();
    simulationExpiresAt.setHours(simulationExpiresAt.getHours() + durationHours);

    // Actualizar usuario con simulación
    await this.firestoreService.updateUser(adminUid, {
      simulatedPlan: plan,
      simulationExpiresAt,
    });

    // Log en audit
    await this.firestoreService.saveAdminAuditLog({
      adminEmail: adminUser.email,
      adminUid: adminUser.uid,
      action: 'simulate_plan',
      endpoint: '/admin/simulate-plan',
      requestParams: {
        simulatedPlan: plan,
        durationHours,
        expiresAt: simulationExpiresAt.toISOString(),
      },
    });

    return {
      success: true,
      data: {
        simulatedPlan: plan,
        simulationExpiresAt: simulationExpiresAt.toISOString(),
        message: `Simulando plan ${plan} por ${durationHours} horas`,
      },
    };
  }

  async getSimulationStatus(adminUid: string) {
    const user = await this.firestoreService.getUserById(adminUid);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const isSimulating =
      user.role === 'admin' &&
      !!user.simulatedPlan &&
      !!user.simulationExpiresAt &&
      new Date() < new Date(user.simulationExpiresAt);

    return {
      success: true,
      data: {
        isSimulating,
        simulatedPlan: isSimulating ? user.simulatedPlan : undefined,
        simulationExpiresAt: isSimulating && user.simulationExpiresAt
          ? new Date(user.simulationExpiresAt).toISOString()
          : undefined,
        originalPlan: user.plan,
        role: user.role || 'user',
      },
    };
  }

  async stopSimulation(adminUid: string, adminUser: AdminUserData) {
    this.logger.log(`Admin ${adminUser.email} stopping plan simulation`);

    const user = await this.firestoreService.getUserById(adminUid);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== 'admin') {
      throw new BadRequestException('Solo los administradores pueden detener simulaciones');
    }

    // Limpiar campos de simulación
    await this.firestoreService.updateUser(adminUid, {
      simulatedPlan: null,
      simulationExpiresAt: null,
    });

    // Log en audit
    await this.firestoreService.saveAdminAuditLog({
      adminEmail: adminUser.email,
      adminUid: adminUser.uid,
      action: 'stop_simulation',
      endpoint: '/admin/simulate-plan/stop',
      requestParams: {},
    });

    return {
      success: true,
      data: {
        message: 'Simulación detenida',
        originalPlan: user.plan,
      },
    };
  }

  // ==================== Labelary Stats ====================

  async getLabelaryStats(hours: number = 24): Promise<LabelaryStatsResponse> {
    this.logger.log(`Fetching Labelary stats for last ${hours} hours`);

    try {
      return await this.labelaryAnalyticsService.getHourlyStats(hours);
    } catch (error) {
      this.logger.error(`Error fetching Labelary stats: ${error.message}`);
      throw error;
    }
  }

  // ==================== Labelary Metrics (Issue #10) ====================

  private readonly DAILY_LIMIT = 5000; // Límite diario de requests a Labelary

  async getLabelaryMetrics(): Promise<LabelaryMetricsResponse> {
    this.logger.log('Fetching Labelary metrics for admin dashboard');

    try {
      // Ejecutar todas las consultas en paralelo
      const [todayStats, hourlyDistribution, weeklyHistory, queueStats] = await Promise.all([
        this.firestoreService.getLabelaryTodayStats(),
        this.firestoreService.getLabelaryHourlyDistribution(),
        this.firestoreService.getLabelaryWeeklyHistory(7),
        Promise.resolve(this.labelaryQueueService.getQueueStats()),
      ]);

      // Calcular métricas de eficiencia
      const totalLabelsProcessed = todayStats.labelCount;
      const uniqueLabelsConverted = todayStats.uniqueLabelCount;
      const apiCallsSaved = totalLabelsProcessed - uniqueLabelsConverted;
      const deduplicationRatio =
        totalLabelsProcessed > 0
          ? Math.round(((totalLabelsProcessed - uniqueLabelsConverted) / totalLabelsProcessed) * 1000) / 10
          : 0;

      // Calcular saturación
      const saturationPercent = Math.round((todayStats.totalCalls / this.DAILY_LIMIT) * 100);
      const saturationLevel = this.calculateSaturationLevel(saturationPercent);
      const estimatedExhaustion = this.calculateEstimatedExhaustion(
        todayStats.totalCalls,
        todayStats.peakHourRequests,
      );

      // Construir respuesta
      const response: LabelaryMetricsResponse = {
        success: true,
        data: {
          summary: {
            requestsToday: todayStats.totalCalls,
            dailyLimit: this.DAILY_LIMIT,
            peakHour: todayStats.peakHour,
            peakHourRequests: todayStats.peakHourRequests,
            queuedUsers: queueStats.totalQueued,
            errors429Today: todayStats.rateLimitHits,
            avgResponseTime: todayStats.avgResponseTimeMs,
          },
          hourlyDistribution,
          weeklyHistory,
          efficiency: {
            totalLabelsProcessed,
            uniqueLabelsConverted,
            deduplicationRatio,
            apiCallsSaved,
          },
          saturation: {
            current: saturationPercent,
            level: saturationLevel,
            estimatedExhaustion,
          },
        },
      };

      return response;
    } catch (error) {
      this.logger.error(`Error fetching Labelary metrics: ${error.message}`);
      throw error;
    }
  }

  /**
   * Determina el nivel de saturación basado en el porcentaje de uso
   */
  private calculateSaturationLevel(percent: number): 'normal' | 'warning' | 'critical' {
    if (percent >= 90) return 'critical';
    if (percent >= 70) return 'warning';
    return 'normal';
  }

  /**
   * Estima la hora de agotamiento del límite diario
   * Basado en la tasa de consumo actual
   */
  private calculateEstimatedExhaustion(
    currentRequests: number,
    peakHourRequests: number,
  ): string | null {
    if (currentRequests >= this.DAILY_LIMIT) {
      return 'Límite alcanzado';
    }

    if (peakHourRequests === 0) {
      return null;
    }

    // Calcular horas restantes basado en la tasa de la hora pico
    const remainingRequests = this.DAILY_LIMIT - currentRequests;
    const hoursRemaining = Math.ceil(remainingRequests / peakHourRequests);

    if (hoursRemaining > 24) {
      return null; // No se agotará hoy
    }

    // Calcular hora estimada de agotamiento
    const now = new Date();
    const exhaustionTime = new Date(now.getTime() + hoursRemaining * 60 * 60 * 1000);
    const hours = String(exhaustionTime.getHours()).padStart(2, '0');
    const minutes = String(exhaustionTime.getMinutes()).padStart(2, '0');

    return `~${hours}:${minutes}`;
  }

  // ==================== Finance (Revenue/MRR/Churn/LTV) ====================

  async getRevenue(period?: string) {
    const validPeriod = (period as 'day' | 'week' | 'month' | 'year') || 'month';
    return this.financeService.getRevenue(validPeriod);
  }

  async getRevenueBreakdown(startDate: Date, endDate: Date) {
    return this.financeService.getRevenueBreakdown(startDate, endDate);
  }

  async getMRRHistory(months: number = 12) {
    return this.financeService.getMRRHistory(months);
  }

  async getTransactions(filters: {
    page?: number;
    limit?: number;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
    currency?: 'usd' | 'mxn';
    type?: 'subscription' | 'refund';
  }) {
    return this.firestoreService.getTransactions(filters);
  }

  async getChurnRate(period?: string) {
    const validPeriod = (period as 'day' | 'week' | 'month' | 'quarter' | 'year') || 'month';
    return this.financeService.getChurnRate(validPeriod);
  }

  async getLTV() {
    return this.financeService.getLTV();
  }

  async getProfitMargin(period?: string) {
    const validPeriod = (period as 'month' | 'quarter' | 'year') || 'month';
    return this.financeService.getProfitMargin(validPeriod);
  }

  async getFinancialDashboard() {
    return this.financeService.getFinancialDashboard();
  }

  // ==================== Expenses ====================

  async createExpense(data: CreateExpenseDto, adminEmail: string) {
    return this.expenseService.createExpense(data, adminEmail);
  }

  async updateExpense(id: string, data: UpdateExpenseDto) {
    return this.expenseService.updateExpense(id, data);
  }

  async deleteExpense(id: string) {
    return this.expenseService.deleteExpense(id);
  }

  async getExpenses(filters: ExpenseFilters) {
    return this.expenseService.getExpenses(filters);
  }

  async getExpenseSummary(startDate: Date, endDate: Date) {
    return this.expenseService.getExpenseSummary(startDate, endDate);
  }

  // ==================== Geography ====================

  async getGeoDistribution() {
    return this.geoService.getUserDistributionByCountry();
  }

  async getGeoConversionRates() {
    return this.geoService.getConversionRatesByCountry();
  }

  async getGeoRevenue(startDate: Date, endDate: Date) {
    return this.geoService.getRevenueByCountry(startDate, endDate);
  }

  async getGeoPotential() {
    return this.geoService.getCountriesWithPotential();
  }

  // ==================== Goals ====================

  async setGoals(data: SetGoalsDto, adminEmail: string) {
    return this.goalsService.setGoals(data, adminEmail);
  }

  async getGoals(month?: string) {
    return this.goalsService.getGoals(month);
  }

  async getGoalsProgress(month?: string) {
    return this.goalsService.getProgress(month);
  }

  async checkGoalAlerts() {
    return this.goalsService.checkAlerts();
  }

  async getGoalsHistory(months: number) {
    const result = await this.goalsService.getHistory(months);
    return {
      success: true,
      data: result,
    };
  }
}
