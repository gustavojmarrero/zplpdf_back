import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum } from 'class-validator';

export class GetConsumptionProjectionQueryDto {
  @ApiPropertyOptional({ enum: ['free', 'pro', 'promax', 'enterprise'], description: 'Filter by plan' })
  @IsOptional()
  @IsEnum(['free', 'pro', 'promax', 'enterprise'])
  plan?: 'free' | 'pro' | 'promax' | 'enterprise';

  @ApiPropertyOptional({ enum: ['critical', 'risk', 'normal'], description: 'Filter by status' })
  @IsOptional()
  @IsEnum(['critical', 'risk', 'normal'])
  status?: 'critical' | 'risk' | 'normal';
}

class ConsumptionProjectionUserDto {
  @ApiProperty({ description: 'User ID' })
  id: string;

  @ApiProperty({ description: 'User email' })
  email: string;

  @ApiProperty({ description: 'User display name' })
  name: string;

  @ApiProperty({ enum: ['free', 'pro', 'promax', 'enterprise'], description: 'User plan' })
  plan: 'free' | 'pro' | 'promax' | 'enterprise';

  @ApiProperty({ description: 'Billing period start date' })
  billingPeriodStart: string;

  @ApiProperty({ description: 'Billing period end date' })
  billingPeriodEnd: string;

  @ApiProperty({ description: 'Plan PDF limit per month' })
  planLimit: number;

  @ApiProperty({ description: 'PDFs used in current period' })
  pdfsUsed: number;

  @ApiProperty({ description: 'Days elapsed since period start' })
  daysElapsed: number;

  @ApiProperty({ description: 'Average PDFs per day' })
  dailyRate: number;

  @ApiProperty({ description: 'Projected days until plan exhaustion' })
  projectedDaysToExhaust: number;

  @ApiProperty({ enum: ['critical', 'risk', 'normal'], description: 'Consumption status' })
  status: 'critical' | 'risk' | 'normal';
}

class ConsumptionSummaryDto {
  @ApiProperty({ description: 'Users in critical status (will exhaust < 15 days)' })
  critical: number;

  @ApiProperty({ description: 'Users at risk (will exhaust in 15-24 days)' })
  risk: number;

  @ApiProperty({ description: 'Users with normal consumption' })
  normal: number;

  @ApiProperty({ description: 'Total users with activity' })
  total: number;
}

class ConsumptionProjectionDataDto {
  @ApiProperty({ type: [ConsumptionProjectionUserDto] })
  users: ConsumptionProjectionUserDto[];

  @ApiProperty({ type: ConsumptionSummaryDto })
  summary: ConsumptionSummaryDto;
}

export class AdminConsumptionProjectionResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: ConsumptionProjectionDataDto })
  data: ConsumptionProjectionDataDto;
}
