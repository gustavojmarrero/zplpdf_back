import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsDateString, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

export class GetConversionsQueryDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'week' })
  @IsOptional()
  @IsEnum(['day', 'week', 'month'])
  period?: 'day' | 'week' | 'month' = 'week';

  @ApiPropertyOptional({ description: 'Start date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    enum: ['free', 'pro', 'promax', 'enterprise'],
    description: 'Filter by user plan type',
  })
  @IsOptional()
  @IsEnum(['free', 'pro', 'promax', 'enterprise'])
  plan?: 'free' | 'pro' | 'promax' | 'enterprise';
}

class ConversionsSummaryDto {
  @ApiProperty()
  totalPdfs: number;

  @ApiProperty()
  totalLabels: number;

  @ApiProperty()
  successCount: number;

  @ApiProperty()
  failureCount: number;

  @ApiProperty()
  avgLabelsPerPdf: number;
}

class TrendItemDto {
  @ApiProperty()
  date: string;

  @ApiProperty()
  pdfs: number;

  @ApiProperty()
  labels: number;

  @ApiProperty()
  failures: number;
}

class PlanStatsDto {
  @ApiProperty()
  pdfs: number;

  @ApiProperty()
  labels: number;
}

class TopUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  plan: string;

  @ApiProperty()
  pdfs: number;

  @ApiProperty()
  labels: number;
}

class ConversionsDataDto {
  @ApiProperty({ type: ConversionsSummaryDto })
  summary: ConversionsSummaryDto;

  @ApiProperty({ type: [TrendItemDto] })
  trend: TrendItemDto[];

  @ApiProperty()
  byPlan: {
    free: PlanStatsDto;
    pro: PlanStatsDto;
    promax: PlanStatsDto;
    enterprise: PlanStatsDto;
  };

  @ApiProperty({ type: [TopUserDto] })
  topUsers: TopUserDto[];
}

export class AdminConversionsResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: ConversionsDataDto })
  data: ConversionsDataDto;
}

// ==================== Conversions List (Individual) ====================

export class GetConversionsListQueryDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Filter by user ID' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Start date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: ['completed', 'failed'], description: 'Filter by status' })
  @IsOptional()
  @IsEnum(['completed', 'failed'])
  status?: 'completed' | 'failed';
}

class ConversionItemDto {
  @ApiProperty({ description: 'Conversion job ID' })
  id: string;

  @ApiProperty({ description: 'User ID' })
  userId: string;

  @ApiProperty({ description: 'User email' })
  userEmail: string;

  @ApiProperty({ description: 'Conversion timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Number of labels in this conversion' })
  labelCount: number;

  @ApiProperty({ description: 'Label size (e.g., "4x6")' })
  labelSize: string;

  @ApiProperty({ enum: ['completed', 'failed'], description: 'Conversion status' })
  status: 'completed' | 'failed';

  @ApiProperty({ enum: ['pdf', 'png', 'jpeg'], description: 'Output format' })
  outputFormat: 'pdf' | 'png' | 'jpeg';

  @ApiPropertyOptional({ description: 'File URL if available' })
  fileUrl?: string;
}

class ConversionsListDataDto {
  @ApiProperty({ type: [ConversionItemDto] })
  conversions: ConversionItemDto[];

  @ApiProperty({ type: PaginationDto })
  pagination: PaginationDto;
}

export class AdminConversionsListResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: ConversionsListDataDto })
  data: ConversionsListDataDto;
}
