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
import { GetConversionsQueryDto, AdminConversionsResponseDto } from './dto/admin-conversions.dto.js';
import { GetErrorsQueryDto, AdminErrorsResponseDto } from './dto/admin-errors.dto.js';
import { AdminPlanUsageResponseDto } from './dto/admin-plan-usage.dto.js';

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
