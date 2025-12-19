import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';
import type { AdminMetricsResponseDto } from './dto/admin-metrics.dto.js';
import type { GetUsersQueryDto, AdminUsersResponseDto } from './dto/admin-users.dto.js';
import type { GetConversionsQueryDto, AdminConversionsResponseDto } from './dto/admin-conversions.dto.js';
import type { GetErrorsQueryDto, AdminErrorsResponseDto } from './dto/admin-errors.dto.js';
import type { AdminPlanUsageResponseDto } from './dto/admin-plan-usage.dto.js';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly firestoreService: FirestoreService) {}

  async getDashboardMetrics(): Promise<AdminMetricsResponseDto> {
    this.logger.log('Fetching dashboard metrics');

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

      return {
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
      });

      return {
        success: true,
        data: result,
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
}
