import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsNumber,
  Min,
  Max,
  IsEnum,
  IsDateString,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GetUsersQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({ enum: ['free', 'pro', 'enterprise'] })
  @IsOptional()
  @IsString()
  plan?: string;

  @ApiPropertyOptional({ description: 'Search by email or name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ['createdAt', 'lastActiveAt', 'pdfCount'], default: 'createdAt' })
  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({ description: 'Filter by registration date from (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Filter by registration date to (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}

class UserUsageDto {
  @ApiProperty()
  pdfCount: number;

  @ApiProperty()
  labelCount: number;
}

class AdminUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ required: false })
  displayName?: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  plan: string;

  @ApiProperty({ type: UserUsageDto })
  usage: UserUsageDto;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ required: false })
  lastActiveAt?: Date;
}

class PaginationDto {
  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  totalPages: number;
}

class AdminUsersDataDto {
  @ApiProperty({ type: [AdminUserDto] })
  users: AdminUserDto[];

  @ApiProperty({ type: PaginationDto })
  pagination: PaginationDto;
}

export class AdminUsersResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: AdminUsersDataDto })
  data: AdminUsersDataDto;
}

// ==================== User Detail DTOs ====================

class UserUsageDetailDto {
  @ApiProperty({ description: 'PDFs generated in current period' })
  pdfCount: number;

  @ApiProperty({ description: 'Labels generated in current period' })
  labelCount: number;

  @ApiProperty({ description: 'PDF limit for the plan' })
  pdfLimit: number;

  @ApiProperty({ description: 'Percentage of limit used' })
  percentUsed: number;
}

class UsageHistoryItemDto {
  @ApiProperty({ description: 'Date (YYYY-MM-DD)' })
  date: string;

  @ApiProperty({ description: 'PDFs generated that day' })
  pdfs: number;

  @ApiProperty({ description: 'Labels generated that day' })
  labels: number;
}

class SubscriptionInfoDto {
  @ApiProperty({
    description: 'Subscription status',
    enum: ['active', 'canceled', 'past_due', 'unpaid', 'trialing', 'incomplete'],
  })
  status: string;

  @ApiProperty({ description: 'Current period start date' })
  currentPeriodStart: string;

  @ApiProperty({ description: 'Current period end date' })
  currentPeriodEnd: string;

  @ApiPropertyOptional({ description: 'Stripe customer ID' })
  stripeCustomerId?: string;

  @ApiPropertyOptional({ description: 'Will cancel at period end' })
  cancelAtPeriodEnd?: boolean;
}

class UserDetailDataDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiPropertyOptional()
  displayName?: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  plan: string;

  @ApiProperty({ type: UserUsageDetailDto })
  usage: UserUsageDetailDto;

  @ApiProperty({ type: [UsageHistoryItemDto], description: 'Usage history for the last 30 days' })
  usageHistory: UsageHistoryItemDto[];

  @ApiPropertyOptional({ type: SubscriptionInfoDto })
  subscription?: SubscriptionInfoDto;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional()
  lastActiveAt?: string;
}

export class AdminUserDetailResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: UserDetailDataDto })
  data: UserDetailDataDto;
}

// ==================== Update Plan DTOs ====================

export class UpdateUserPlanDto {
  @ApiProperty({
    enum: ['free', 'pro', 'enterprise'],
    description: 'New plan to assign',
  })
  @IsEnum(['free', 'pro', 'enterprise'], {
    message: 'Plan must be: free, pro, or enterprise',
  })
  @IsNotEmpty()
  newPlan: 'free' | 'pro' | 'enterprise';

  @ApiProperty({
    description: 'Reason for the plan change',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

class UpdatePlanResultDto {
  @ApiProperty()
  userId: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  previousPlan: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  newPlan: string;

  @ApiProperty()
  effectiveAt: string;

  @ApiPropertyOptional({ description: 'Whether Stripe subscription was canceled' })
  stripeCanceled?: boolean;

  @ApiPropertyOptional({ description: 'Warnings during the process', type: [String] })
  warnings?: string[];
}

export class UpdateUserPlanResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: UpdatePlanResultDto })
  data: UpdatePlanResultDto;
}
