import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Min, Max, IsDateString, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

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
  @ApiProperty()
  id: string;

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
  timestamp: Date;

  @ApiProperty({ enum: ['error', 'warning', 'critical'] })
  severity: string;

  @ApiProperty({ type: ErrorContextDto, required: false })
  context?: ErrorContextDto;
}

class ErrorsSummaryDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  bySeverity: {
    error: number;
    warning: number;
    critical: number;
  };

  @ApiProperty()
  byType: Record<string, number>;
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
