import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Param,
  Body,
  UseGuards,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiHeader,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { AdminUser } from '../../common/decorators/admin-user.decorator.js';
import type { AdminUserData } from '../../common/decorators/admin-user.decorator.js';
import { AdminService } from './admin.service.js';
import { AdminMetricsResponseDto } from './dto/admin-metrics.dto.js';
import {
  GetUsersQueryDto,
  AdminUsersResponseDto,
  AdminUserDetailResponseDto,
  UpdateUserPlanDto,
  UpdateUserPlanResponseDto,
} from './dto/admin-users.dto.js';
import { GetConversionsQueryDto, AdminConversionsResponseDto, GetConversionsListQueryDto, AdminConversionsListResponseDto } from './dto/admin-conversions.dto.js';
import {
  GetErrorsQueryDto,
  AdminErrorsResponseDto,
  AdminErrorDetailResponseDto,
  UpdateErrorDto,
  UpdateErrorResponseDto,
  AdminErrorStatsResponseDto,
} from './dto/admin-errors.dto.js';
import { AdminPlanUsageResponseDto } from './dto/admin-plan-usage.dto.js';
import { GetPlanChangesQueryDto, AdminPlanChangesResponseDto } from './dto/admin-plan-changes.dto.js';
import { GetConsumptionProjectionQueryDto, AdminConsumptionProjectionResponseDto } from './dto/admin-consumption-projection.dto.js';
import {
  SimulatePlanDto,
  SimulatePlanResponseDto,
  SimulationStatusResponseDto,
  StopSimulationResponseDto,
} from './dto/admin-simulate-plan.dto.js';
import {
  GetRevenueQueryDto,
  GetTransactionsQueryDto,
  CreateExpenseDto,
  UpdateExpenseDto,
  GetExpensesQueryDto,
  SetGoalsDto,
  GetGoalsQueryDto,
  GetGeoRevenueQueryDto,
  GetChurnQueryDto,
  GetProfitQueryDto,
} from './dto/admin-finance.dto.js';

@ApiTags('admin')
@ApiBearerAuth()
@ApiHeader({
  name: 'X-Firebase-UID',
  description: 'Firebase UID of the admin user',
  required: true,
})
@ApiHeader({
  name: 'X-Admin-Email',
  description: 'Email of the admin user (must match token)',
  required: true,
})
@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(private readonly adminService: AdminService) {}

  @Get('metrics')
  @ApiOperation({
    summary: 'Get dashboard metrics',
    description: 'Returns all main metrics for the admin dashboard including users, conversions, errors, and plan usage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard metrics retrieved successfully',
    type: AdminMetricsResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getMetrics(@AdminUser() admin: AdminUserData): Promise<AdminMetricsResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting dashboard metrics`);
    return this.adminService.getDashboardMetrics();
  }

  @Get('users')
  @ApiOperation({
    summary: 'Get users list',
    description: 'Returns a paginated list of all users with optional filtering and sorting.',
  })
  @ApiResponse({
    status: 200,
    description: 'Users list retrieved successfully',
    type: AdminUsersResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getUsers(
    @Query() query: GetUsersQueryDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<AdminUsersResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting users list`);
    return this.adminService.getUsers(query);
  }

  @Get('conversions/list')
  @ApiOperation({
    summary: 'Get individual conversions list',
    description: 'Returns a paginated list of individual conversions with optional filtering by user, date range, and status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Conversions list retrieved successfully',
    type: AdminConversionsListResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getConversionsList(
    @Query() query: GetConversionsListQueryDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<AdminConversionsListResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting conversions list`);
    return this.adminService.getConversionsList(query);
  }

  @Get('conversions')
  @ApiOperation({
    summary: 'Get conversion statistics',
    description: 'Returns detailed conversion statistics including trends and breakdown by plan.',
  })
  @ApiResponse({
    status: 200,
    description: 'Conversion statistics retrieved successfully',
    type: AdminConversionsResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getConversions(
    @Query() query: GetConversionsQueryDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<AdminConversionsResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting conversion stats`);
    return this.adminService.getConversions(query);
  }

  @Get('errors')
  @ApiOperation({
    summary: 'Get error logs',
    description: 'Returns a paginated list of error logs with optional filtering by severity, type, date, and user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Error logs retrieved successfully',
    type: AdminErrorsResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getErrors(
    @Query() query: GetErrorsQueryDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<AdminErrorsResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting error logs`);
    return this.adminService.getErrors(query);
  }

  @Get('errors/stats')
  @ApiOperation({
    summary: 'Get error statistics',
    description: 'Returns aggregated error statistics including counts by status, severity, type, source, and trend data.',
  })
  @ApiResponse({
    status: 200,
    description: 'Error statistics retrieved successfully',
    type: AdminErrorStatsResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getErrorStats(@AdminUser() admin: AdminUserData): Promise<AdminErrorStatsResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting error stats`);
    return this.adminService.getErrorStats();
  }

  @Get('errors/:id')
  @ApiOperation({
    summary: 'Get error detail by ID',
    description: 'Returns detailed information about a specific error by document ID or errorId (ERR-YYYYMMDD-XXXXX).',
  })
  @ApiParam({
    name: 'id',
    description: 'Error document ID or errorId (ERR-YYYYMMDD-XXXXX)',
    example: 'ERR-20251222-00042',
  })
  @ApiResponse({
    status: 200,
    description: 'Error detail retrieved successfully',
    type: AdminErrorDetailResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  @ApiResponse({ status: 404, description: 'Error not found' })
  async getErrorDetail(
    @Param('id') id: string,
    @AdminUser() admin: AdminUserData,
  ): Promise<AdminErrorDetailResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting error detail: ${id}`);
    return this.adminService.getErrorDetail(id);
  }

  @Patch('errors/:id')
  @ApiOperation({
    summary: 'Update error status/notes',
    description: 'Update the status and/or notes of an error. When status changes to "resolved", resolvedAt is set automatically.',
  })
  @ApiParam({
    name: 'id',
    description: 'Error document ID or errorId (ERR-YYYYMMDD-XXXXX)',
    example: 'ERR-20251222-00042',
  })
  @ApiBody({ type: UpdateErrorDto })
  @ApiResponse({
    status: 200,
    description: 'Error updated successfully',
    type: UpdateErrorResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  @ApiResponse({ status: 404, description: 'Error not found' })
  async updateError(
    @Param('id') id: string,
    @Body() dto: UpdateErrorDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<UpdateErrorResponseDto> {
    this.logger.log(`Admin ${admin.email} updating error: ${id}`);
    return this.adminService.updateError(id, dto, admin);
  }

  @Get('plan-usage')
  @ApiOperation({
    summary: 'Get plan usage metrics',
    description: 'Returns metrics about plan usage, distribution, users near limits, and upgrade opportunities.',
  })
  @ApiResponse({
    status: 200,
    description: 'Plan usage metrics retrieved successfully',
    type: AdminPlanUsageResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getPlanUsage(@AdminUser() admin: AdminUserData): Promise<AdminPlanUsageResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting plan usage`);
    return this.adminService.getPlanUsage();
  }

  @Get('plan-changes')
  @ApiOperation({
    summary: 'Get plan changes history',
    description: 'Returns a paginated list of plan changes (upgrades, downgrades, admin changes) with optional filtering.',
  })
  @ApiResponse({
    status: 200,
    description: 'Plan changes history retrieved successfully',
    type: AdminPlanChangesResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getPlanChanges(
    @Query() query: GetPlanChangesQueryDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<AdminPlanChangesResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting plan changes history`);
    return this.adminService.getPlanChanges(query);
  }

  @Get('consumption-projection')
  @ApiOperation({
    summary: 'Get consumption projection for all users',
    description: 'Returns projected plan exhaustion data for users, identifying those who will exhaust their plan before billing period ends.',
  })
  @ApiResponse({
    status: 200,
    description: 'Consumption projection data retrieved successfully',
    type: AdminConsumptionProjectionResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getConsumptionProjection(
    @Query() query: GetConsumptionProjectionQueryDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<AdminConsumptionProjectionResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting consumption projection`);
    return this.adminService.getConsumptionProjection(query);
  }

  @Get('users/:userId')
  @ApiOperation({
    summary: 'Get user detail',
    description: 'Returns detailed information about a specific user including usage, subscription, and activity history.',
  })
  @ApiParam({
    name: 'userId',
    description: 'Firebase UID of the user',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'User detail retrieved successfully',
    type: AdminUserDetailResponseDto,
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getUserDetail(
    @Param('userId') userId: string,
    @AdminUser() admin: AdminUserData,
  ): Promise<AdminUserDetailResponseDto> {
    this.logger.log(`Admin ${admin.email} requesting user detail for ${userId}`);
    return this.adminService.getUserDetail(userId);
  }

  @Patch('users/:userId/plan')
  @ApiOperation({
    summary: 'Update user plan',
    description: 'Changes the plan for a specific user. Automatically cancels Stripe subscription when downgrading.',
  })
  @ApiParam({
    name: 'userId',
    description: 'Firebase UID of the user',
    type: String,
  })
  @ApiBody({ type: UpdateUserPlanDto })
  @ApiResponse({
    status: 200,
    description: 'User plan updated successfully',
    type: UpdateUserPlanResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request - Same plan or invalid data' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async updateUserPlan(
    @Param('userId') userId: string,
    @Body() dto: UpdateUserPlanDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<UpdateUserPlanResponseDto> {
    this.logger.log(`Admin ${admin.email} updating plan for user ${userId}`);
    return this.adminService.updateUserPlan(userId, dto, admin);
  }

  // ==================== Simulación de Plan ====================

  @Post('simulate-plan')
  @ApiOperation({
    summary: 'Simulate a plan',
    description: 'Allows an admin to simulate a different plan for testing purposes. The simulation affects limits and usage calculations.',
  })
  @ApiBody({ type: SimulatePlanDto })
  @ApiResponse({
    status: 201,
    description: 'Plan simulation started successfully',
    type: SimulatePlanResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid plan or not an admin' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async simulatePlan(
    @Body() dto: SimulatePlanDto,
    @AdminUser() admin: AdminUserData,
  ): Promise<SimulatePlanResponseDto> {
    this.logger.log(`Admin ${admin.email} starting plan simulation: ${dto.plan}`);
    return this.adminService.simulatePlan(admin.uid, dto.plan, dto.durationHours, admin);
  }

  @Get('simulate-plan/status')
  @ApiOperation({
    summary: 'Get simulation status',
    description: 'Returns the current simulation status for the authenticated admin.',
  })
  @ApiResponse({
    status: 200,
    description: 'Simulation status retrieved successfully',
    type: SimulationStatusResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getSimulationStatus(@AdminUser() admin: AdminUserData): Promise<SimulationStatusResponseDto> {
    this.logger.log(`Admin ${admin.email} checking simulation status`);
    return this.adminService.getSimulationStatus(admin.uid);
  }

  @Post('simulate-plan/stop')
  @ApiOperation({
    summary: 'Stop plan simulation',
    description: 'Stops the current plan simulation and reverts to the original plan.',
  })
  @ApiResponse({
    status: 201,
    description: 'Plan simulation stopped successfully',
    type: StopSimulationResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request - Not an admin' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async stopSimulation(@AdminUser() admin: AdminUserData): Promise<StopSimulationResponseDto> {
    this.logger.log(`Admin ${admin.email} stopping plan simulation`);
    return this.adminService.stopSimulation(admin.uid, admin);
  }

  // ==================== Labelary Analytics ====================

  @Get('labelary-stats')
  @ApiOperation({
    summary: 'Get Labelary API statistics',
    description: 'Returns hourly statistics of Labelary API usage including calls, errors, rate limits, and response times.',
  })
  @ApiResponse({
    status: 200,
    description: 'Labelary statistics retrieved successfully',
    schema: {
      properties: {
        hourlyData: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              hourKey: { type: 'string', example: '2025-12-23T14' },
              totalCalls: { type: 'number', example: 150 },
              successCount: { type: 'number', example: 145 },
              errorCount: { type: 'number', example: 3 },
              rateLimitHits: { type: 'number', example: 2 },
              avgResponseTimeMs: { type: 'number', example: 850 },
              labelCount: { type: 'number', example: 1200 },
            },
          },
        },
        summary: {
          type: 'object',
          properties: {
            totalCalls: { type: 'number', example: 2500 },
            avgResponseTimeMs: { type: 'number', example: 800 },
            errorRate: { type: 'number', example: 1.5 },
            rateLimitRate: { type: 'number', example: 0.8 },
            peakHour: { type: 'string', example: '2025-12-23T14' },
            peakCallCount: { type: 'number', example: 200 },
            totalLabelsProcessed: { type: 'number', example: 15000 },
          },
        },
        period: {
          type: 'object',
          properties: {
            hours: { type: 'number', example: 24 },
            startHour: { type: 'string', example: '2025-12-22T14' },
            endHour: { type: 'string', example: '2025-12-23T14' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getLabelaryStats(
    @Query('hours') hours: string = '24',
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting Labelary stats for ${hours} hours`);
    return this.adminService.getLabelaryStats(parseInt(hours, 10) || 24);
  }

  // ==================== Labelary Metrics (Issue #10) ====================

  @Get('labelary-metrics')
  @ApiOperation({
    summary: 'Get Labelary API metrics for dashboard',
    description:
      'Returns comprehensive metrics for the Labelary API usage dashboard including daily consumption, hourly distribution, weekly history, efficiency metrics, and saturation levels.',
  })
  @ApiResponse({
    status: 200,
    description: 'Labelary metrics retrieved successfully',
    schema: {
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            summary: {
              type: 'object',
              properties: {
                requestsToday: { type: 'number', example: 2450 },
                dailyLimit: { type: 'number', example: 5000 },
                peakHour: { type: 'string', example: '14:00' },
                peakHourRequests: { type: 'number', example: 320 },
                queuedUsers: { type: 'number', example: 3 },
                errors429Today: { type: 'number', example: 12 },
                avgResponseTime: { type: 'number', example: 245 },
              },
            },
            hourlyDistribution: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  hour: { type: 'string', example: '00:00' },
                  requests: { type: 'number', example: 45 },
                  errors: { type: 'number', example: 0 },
                },
              },
            },
            weeklyHistory: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string', example: '2025-12-17' },
                  requests: { type: 'number', example: 4200 },
                  errors: { type: 'number', example: 5 },
                  uniqueLabels: { type: 'number', example: 3800 },
                },
              },
            },
            efficiency: {
              type: 'object',
              properties: {
                totalLabelsProcessed: { type: 'number', example: 15000 },
                uniqueLabelsConverted: { type: 'number', example: 12500 },
                deduplicationRatio: { type: 'number', example: 16.7 },
                apiCallsSaved: { type: 'number', example: 2500 },
              },
            },
            saturation: {
              type: 'object',
              properties: {
                current: { type: 'number', example: 49 },
                level: { type: 'string', enum: ['normal', 'warning', 'critical'], example: 'normal' },
                estimatedExhaustion: { type: 'string', nullable: true, example: null },
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin access required' })
  async getLabelaryMetrics(@AdminUser() admin: AdminUserData) {
    this.logger.log(`Admin ${admin.email} requesting Labelary metrics`);
    return this.adminService.getLabelaryMetrics();
  }

  // ==================== Finance - Revenue ====================

  @Get('revenue')
  @ApiOperation({
    summary: 'Get revenue metrics',
    description: 'Returns revenue data for the specified period with MRR information.',
  })
  @ApiResponse({ status: 200, description: 'Revenue data retrieved successfully' })
  async getRevenue(
    @Query('period') period: string = 'month',
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting revenue metrics`);
    return this.adminService.getRevenue(period);
  }

  @Get('revenue/breakdown')
  @ApiOperation({
    summary: 'Get revenue breakdown',
    description: 'Returns revenue breakdown by currency and country for the specified period.',
  })
  @ApiResponse({ status: 200, description: 'Revenue breakdown retrieved successfully' })
  async getRevenueBreakdown(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting revenue breakdown`);
    return this.adminService.getRevenueBreakdown(new Date(startDate), new Date(endDate));
  }

  @Get('transactions')
  @ApiOperation({
    summary: 'Get transactions list',
    description: 'Returns a paginated list of Stripe transactions with optional filtering.',
  })
  @ApiResponse({ status: 200, description: 'Transactions list retrieved successfully' })
  async getTransactions(
    @Query() query: GetTransactionsQueryDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting transactions`);
    return this.adminService.getTransactions({
      page: query.page,
      limit: query.limit,
      userId: query.userId,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      currency: query.currency,
      type: query.type,
    });
  }

  @Get('mrr-history')
  @ApiOperation({
    summary: 'Get MRR history',
    description: 'Returns Monthly Recurring Revenue history for the specified number of months.',
  })
  @ApiResponse({ status: 200, description: 'MRR history retrieved successfully' })
  async getMRRHistory(
    @Query('months') months: string = '12',
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting MRR history`);
    return this.adminService.getMRRHistory(parseInt(months, 10) || 12);
  }

  // ==================== Finance - Expenses ====================

  @Get('expenses')
  @ApiOperation({
    summary: 'Get expenses list',
    description: 'Returns a paginated list of expenses with optional filtering.',
  })
  @ApiResponse({ status: 200, description: 'Expenses list retrieved successfully' })
  async getExpenses(
    @Query() query: GetExpensesQueryDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting expenses`);
    return this.adminService.getExpenses({
      page: query.page,
      limit: query.limit,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      category: query.category,
      type: query.type,
    });
  }

  @Post('expenses')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create expense',
    description: 'Creates a new expense. USD amounts are automatically converted to MXN using Banxico rates.',
  })
  @ApiBody({ type: CreateExpenseDto })
  @ApiResponse({ status: 201, description: 'Expense created successfully' })
  async createExpense(
    @Body() dto: CreateExpenseDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} creating expense`);
    return this.adminService.createExpense(
      {
        ...dto,
        date: dto.date ? new Date(dto.date) : undefined,
      },
      admin.email,
    );
  }

  @Patch('expenses/:id')
  @ApiOperation({
    summary: 'Update expense',
    description: 'Updates an existing expense.',
  })
  @ApiParam({ name: 'id', description: 'Expense ID' })
  @ApiBody({ type: UpdateExpenseDto })
  @ApiResponse({ status: 200, description: 'Expense updated successfully' })
  async updateExpense(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} updating expense ${id}`);
    return this.adminService.updateExpense(id, dto);
  }

  @Delete('expenses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete expense',
    description: 'Deletes an expense.',
  })
  @ApiParam({ name: 'id', description: 'Expense ID' })
  @ApiResponse({ status: 204, description: 'Expense deleted successfully' })
  async deleteExpense(
    @Param('id') id: string,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} deleting expense ${id}`);
    return this.adminService.deleteExpense(id);
  }

  @Get('expenses/summary')
  @ApiOperation({
    summary: 'Get expense summary',
    description: 'Returns expense summary by category and vendor for the specified period.',
  })
  @ApiResponse({ status: 200, description: 'Expense summary retrieved successfully' })
  async getExpenseSummary(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting expense summary`);
    return this.adminService.getExpenseSummary(new Date(startDate), new Date(endDate));
  }

  // ==================== Goals ====================

  @Get('goals')
  @ApiOperation({
    summary: 'Get monthly goals',
    description: 'Returns the goals for the specified month (defaults to current month).',
  })
  @ApiResponse({ status: 200, description: 'Goals retrieved successfully' })
  async getGoals(
    @Query() query: GetGoalsQueryDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting goals`);
    return this.adminService.getGoals(query.month);
  }

  @Post('goals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set monthly goals',
    description: 'Sets or updates goals for the specified month.',
  })
  @ApiBody({ type: SetGoalsDto })
  @ApiResponse({ status: 200, description: 'Goals set successfully' })
  async setGoals(
    @Body() dto: SetGoalsDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} setting goals for ${dto.month}`);
    return this.adminService.setGoals(dto, admin.email);
  }

  @Get('goals/progress')
  @ApiOperation({
    summary: 'Get goals progress',
    description: 'Returns progress toward monthly goals with alerts and status.',
  })
  @ApiResponse({ status: 200, description: 'Goals progress retrieved successfully' })
  async getGoalsProgress(
    @Query() query: GetGoalsQueryDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting goals progress`);
    return this.adminService.getGoalsProgress(query.month);
  }

  @Get('goals/alerts')
  @ApiOperation({
    summary: 'Check goal alerts',
    description: 'Returns current alerts for monthly goals.',
  })
  @ApiResponse({ status: 200, description: 'Goal alerts retrieved successfully' })
  async checkGoalAlerts(@AdminUser() admin: AdminUserData) {
    this.logger.log(`Admin ${admin.email} checking goal alerts`);
    return this.adminService.checkGoalAlerts();
  }

  // ==================== Geography ====================

  @Get('geo/distribution')
  @ApiOperation({
    summary: 'Get user distribution by country',
    description: 'Returns the distribution of users by country with plan breakdown.',
  })
  @ApiResponse({ status: 200, description: 'Distribution data retrieved successfully' })
  async getGeoDistribution(@AdminUser() admin: AdminUserData) {
    this.logger.log(`Admin ${admin.email} requesting geo distribution`);
    return this.adminService.getGeoDistribution();
  }

  @Get('geo/conversion-rates')
  @ApiOperation({
    summary: 'Get conversion rates by country',
    description: 'Returns Free→Pro conversion rates by country.',
  })
  @ApiResponse({ status: 200, description: 'Conversion rates retrieved successfully' })
  async getGeoConversionRates(@AdminUser() admin: AdminUserData) {
    this.logger.log(`Admin ${admin.email} requesting geo conversion rates`);
    return this.adminService.getGeoConversionRates();
  }

  @Get('geo/revenue')
  @ApiOperation({
    summary: 'Get revenue by country',
    description: 'Returns revenue data by country for the specified period.',
  })
  @ApiResponse({ status: 200, description: 'Revenue by country retrieved successfully' })
  async getGeoRevenue(
    @Query() query: GetGeoRevenueQueryDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting geo revenue`);
    return this.adminService.getGeoRevenue(new Date(query.startDate), new Date(query.endDate));
  }

  @Get('geo/potential')
  @ApiOperation({
    summary: 'Get countries with potential',
    description: 'Returns countries ranked by potential for growth and marketing investment.',
  })
  @ApiResponse({ status: 200, description: 'Country potential data retrieved successfully' })
  async getGeoPotential(@AdminUser() admin: AdminUserData) {
    this.logger.log(`Admin ${admin.email} requesting geo potential`);
    return this.adminService.getGeoPotential();
  }

  // ==================== Advanced Metrics ====================

  @Get('metrics/churn')
  @ApiOperation({
    summary: 'Get churn rate',
    description: 'Returns subscription churn rate for the specified period.',
  })
  @ApiResponse({ status: 200, description: 'Churn rate retrieved successfully' })
  async getChurnRate(
    @Query() query: GetChurnQueryDto,
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting churn rate`);
    return this.adminService.getChurnRate(query.period);
  }

  @Get('metrics/ltv')
  @ApiOperation({
    summary: 'Get Customer Lifetime Value',
    description: 'Returns average customer lifetime value metrics.',
  })
  @ApiResponse({ status: 200, description: 'LTV data retrieved successfully' })
  async getLTV(@AdminUser() admin: AdminUserData) {
    this.logger.log(`Admin ${admin.email} requesting LTV`);
    return this.adminService.getLTV();
  }

  @Get('metrics/profit')
  @ApiOperation({
    summary: 'Get profit margin',
    description: 'Returns profit margin for the specified period.',
  })
  @ApiResponse({ status: 200, description: 'Profit data retrieved successfully' })
  async getProfitMargin(
    @Query('period') period: string = 'month',
    @AdminUser() admin: AdminUserData,
  ) {
    this.logger.log(`Admin ${admin.email} requesting profit margin`);
    return this.adminService.getProfitMargin(period);
  }

  @Get('finance/dashboard')
  @ApiOperation({
    summary: 'Get financial dashboard',
    description: 'Returns comprehensive financial dashboard with revenue, expenses, MRR, and profit.',
  })
  @ApiResponse({ status: 200, description: 'Financial dashboard retrieved successfully' })
  async getFinancialDashboard(@AdminUser() admin: AdminUserData) {
    this.logger.log(`Admin ${admin.email} requesting financial dashboard`);
    return this.adminService.getFinancialDashboard();
  }
}
