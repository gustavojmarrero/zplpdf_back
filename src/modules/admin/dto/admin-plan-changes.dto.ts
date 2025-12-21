import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsDateString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class GetPlanChangesQueryDto {
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
}

class PlanChangeItemDto {
  @ApiProperty({ description: 'User ID' })
  userId: string;

  @ApiProperty({ description: 'User email' })
  userEmail: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'], description: 'Previous plan' })
  previousPlan: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'], description: 'New plan' })
  newPlan: string;

  @ApiProperty({ description: 'When the change occurred' })
  changedAt: string;

  @ApiProperty({ enum: ['upgrade', 'downgrade', 'admin_change'], description: 'Reason for change' })
  reason: 'upgrade' | 'downgrade' | 'admin_change';

  @ApiPropertyOptional({ description: 'Admin email who made the change' })
  changedBy?: string;
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

class PlanChangesDataDto {
  @ApiProperty({ type: [PlanChangeItemDto] })
  changes: PlanChangeItemDto[];

  @ApiProperty({ type: PaginationDto })
  pagination: PaginationDto;
}

export class AdminPlanChangesResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: PlanChangesDataDto })
  data: PlanChangesDataDto;
}
