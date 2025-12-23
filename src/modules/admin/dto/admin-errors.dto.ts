import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsNumber,
  Min,
  Max,
  IsDateString,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

// Types
export type ErrorStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';
export type ErrorSource = 'frontend' | 'backend' | 'system';

export class GetErrorsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 100, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(500)
  limit?: number = 100;

  @ApiPropertyOptional({ enum: ['error', 'warning', 'critical'] })
  @IsOptional()
  @IsEnum(['error', 'warning', 'critical'])
  severity?: string;

  @ApiPropertyOptional({ description: 'Filter by error type' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'Start date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Filter by user ID' })
  @IsOptional()
  @IsString()
  userId?: string;

  // New filters
  @ApiPropertyOptional({
    enum: ['open', 'investigating', 'resolved', 'dismissed'],
    description: 'Filter by error status',
  })
  @IsOptional()
  @IsEnum(['open', 'investigating', 'resolved', 'dismissed'])
  status?: ErrorStatus;

  @ApiPropertyOptional({
    enum: ['frontend', 'backend', 'system'],
    description: 'Filter by error source',
  })
  @IsOptional()
  @IsEnum(['frontend', 'backend', 'system'])
  source?: ErrorSource;

  @ApiPropertyOptional({
    description: 'Search by error ID (ERR-YYYYMMDD-XXXXX)',
    example: 'ERR-20251222-00042',
  })
  @IsOptional()
  @IsString()
  errorId?: string;
}

class ErrorContextDto {
  @ApiProperty({ required: false })
  line?: number;

  @ApiProperty({ required: false })
  command?: string;

  @ApiProperty({ required: false })
  input_length?: number;

  @ApiProperty({ required: false })
  label_count?: number;

  @ApiProperty({ required: false })
  elapsed_ms?: number;

  @ApiProperty({ required: false })
  output_format?: string;

  @ApiProperty({ required: false })
  service?: string;

  @ApiProperty({ required: false })
  pool_size?: number;

  @ApiProperty({ required: false })
  active_connections?: number;
}

class ErrorItemDto {
  @ApiProperty({ description: 'Firestore document ID' })
  id: string;

  @ApiProperty({ description: 'Unique error ID (ERR-YYYYMMDD-XXXXX)', example: 'ERR-20251222-00042' })
  errorId: string;

  @ApiProperty()
  type: string;

  @ApiProperty()
  code: string;

  @ApiProperty()
  message: string;

  @ApiProperty({ required: false })
  userId?: string;

  @ApiProperty({ required: false })
  userEmail?: string;

  @ApiProperty({ required: false })
  jobId?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ required: false })
  updatedAt?: Date;

  @ApiProperty({ enum: ['error', 'warning', 'critical'] })
  severity: string;

  @ApiProperty({ enum: ['open', 'investigating', 'resolved', 'dismissed'], default: 'open' })
  status: ErrorStatus;

  @ApiProperty({ enum: ['frontend', 'backend', 'system'], default: 'backend' })
  source: ErrorSource;

  @ApiProperty({ required: false, description: 'Admin notes' })
  notes?: string;

  @ApiProperty({ required: false, description: 'When error was resolved' })
  resolvedAt?: Date;

  @ApiProperty({ required: false, description: 'URL where error occurred' })
  url?: string;

  @ApiProperty({ required: false, description: 'Stack trace' })
  stackTrace?: string;

  @ApiProperty({ required: false, description: 'User agent' })
  userAgent?: string;

  @ApiProperty({ type: ErrorContextDto, required: false })
  context?: ErrorContextDto;
}

class ErrorsSummaryDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  bySeverity: Record<string, number>;

  @ApiProperty()
  byType: Record<string, number>;

  @ApiProperty()
  byStatus: Record<string, number>;

  @ApiProperty()
  bySource: Record<string, number>;
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

class ErrorsDataDto {
  @ApiProperty({ type: [ErrorItemDto] })
  errors: ErrorItemDto[];

  @ApiProperty({ type: ErrorsSummaryDto })
  summary: ErrorsSummaryDto;

  @ApiProperty({ type: PaginationDto })
  pagination: PaginationDto;
}

export class AdminErrorsResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: ErrorsDataDto })
  data: ErrorsDataDto;
}

// ============== Error Detail ==============

export class AdminErrorDetailResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: ErrorItemDto })
  data: ErrorItemDto;
}

// ============== Update Error ==============

export class UpdateErrorDto {
  @ApiPropertyOptional({
    enum: ['open', 'investigating', 'resolved', 'dismissed'],
    description: 'New status for the error',
  })
  @IsOptional()
  @IsEnum(['open', 'investigating', 'resolved', 'dismissed'])
  status?: ErrorStatus;

  @ApiPropertyOptional({
    description: 'Admin notes about this error',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateErrorResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({
    type: 'object',
    properties: {
      id: { type: 'string' },
      errorId: { type: 'string' },
      status: { type: 'string' },
      notes: { type: 'string' },
      resolvedAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  })
  data: {
    id: string;
    errorId: string;
    status: ErrorStatus;
    notes?: string;
    resolvedAt?: Date;
    updatedAt: Date;
  };
}

// ============== Error Stats ==============

class TrendItemDto {
  @ApiProperty()
  date: string;

  @ApiProperty()
  count: number;
}

class ErrorStatsDataDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  byStatus: Record<string, number>;

  @ApiProperty()
  bySeverity: Record<string, number>;

  @ApiProperty()
  byType: Record<string, number>;

  @ApiProperty()
  bySource: Record<string, number>;

  @ApiProperty()
  last24Hours: number;

  @ApiProperty()
  last7Days: number;

  @ApiProperty()
  last30Days: number;

  @ApiProperty({ type: [TrendItemDto] })
  trend: TrendItemDto[];
}

export class AdminErrorStatsResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: ErrorStatsDataDto })
  data: ErrorStatsDataDto;
}
