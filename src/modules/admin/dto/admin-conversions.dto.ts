import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsDateString, IsEnum } from 'class-validator';

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
