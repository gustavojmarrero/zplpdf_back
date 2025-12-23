import {
  Controller,
  Get,
  Patch,
  Query,
  Param,
  Body,
  UseGuards,
  Logger,
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
}
