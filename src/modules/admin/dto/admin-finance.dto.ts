import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, IsEnum, IsDateString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

// ==================== Revenue ====================

export class GetRevenueQueryDto {
  @ApiPropertyOptional({ description: 'Period (day, week, month)', default: 'month' })
  @IsOptional()
  @IsString()
  period?: string;

  @ApiPropertyOptional({ description: 'Start date (ISO string)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO string)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class GetTransactionsQueryDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by user ID' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Start date (ISO string)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO string)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: ['usd', 'mxn'], description: 'Filter by currency' })
  @IsOptional()
  @IsEnum(['usd', 'mxn'])
  currency?: 'usd' | 'mxn';

  @ApiPropertyOptional({ enum: ['subscription', 'refund'], description: 'Filter by type' })
  @IsOptional()
  @IsEnum(['subscription', 'refund'])
  type?: 'subscription' | 'refund';
}

// ==================== Expenses ====================

export class CreateExpenseDto {
  @ApiProperty({ description: 'Amount in original currency' })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ enum: ['usd', 'mxn'], description: 'Currency' })
  @IsEnum(['usd', 'mxn'])
  currency: 'usd' | 'mxn';

  @ApiProperty({ enum: ['recurring', 'one_time'], description: 'Expense type' })
  @IsEnum(['recurring', 'one_time'])
  type: 'recurring' | 'one_time';

  @ApiProperty({ enum: ['hosting', 'advertising', 'tools', 'other'], description: 'Category' })
  @IsEnum(['hosting', 'advertising', 'tools', 'other'])
  category: 'hosting' | 'advertising' | 'tools' | 'other';

  @ApiProperty({ description: 'Description of the expense' })
  @IsString()
  description: string;

  @ApiPropertyOptional({ description: 'Vendor/Provider name' })
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiPropertyOptional({ enum: ['monthly', 'annual'], description: 'Recurrence type (required if type is recurring)' })
  @IsOptional()
  @IsEnum(['monthly', 'annual'])
  recurrenceType?: 'monthly' | 'annual';

  @ApiPropertyOptional({ description: 'Date of the expense (ISO string, defaults to now)' })
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class UpdateExpenseDto {
  @ApiPropertyOptional({ description: 'Amount in original currency' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional({ enum: ['usd', 'mxn'], description: 'Currency' })
  @IsOptional()
  @IsEnum(['usd', 'mxn'])
  currency?: 'usd' | 'mxn';

  @ApiPropertyOptional({ enum: ['hosting', 'advertising', 'tools', 'other'], description: 'Category' })
  @IsOptional()
  @IsEnum(['hosting', 'advertising', 'tools', 'other'])
  category?: 'hosting' | 'advertising' | 'tools' | 'other';

  @ApiPropertyOptional({ description: 'Description of the expense' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Vendor/Provider name' })
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiPropertyOptional({ enum: ['monthly', 'annual'], description: 'Recurrence type' })
  @IsOptional()
  @IsEnum(['monthly', 'annual'])
  recurrenceType?: 'monthly' | 'annual';
}

export class GetExpensesQueryDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Start date (ISO string)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO string)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: ['hosting', 'advertising', 'tools', 'other'], description: 'Filter by category' })
  @IsOptional()
  @IsEnum(['hosting', 'advertising', 'tools', 'other'])
  category?: 'hosting' | 'advertising' | 'tools' | 'other';

  @ApiPropertyOptional({ enum: ['recurring', 'one_time'], description: 'Filter by type' })
  @IsOptional()
  @IsEnum(['recurring', 'one_time'])
  type?: 'recurring' | 'one_time';
}

// ==================== Goals ====================

export class SetGoalsDto {
  @ApiProperty({ description: 'Month in YYYY-MM format', example: '2025-01' })
  @IsString()
  month: string;

  @ApiProperty({
    description: 'Monthly targets',
    example: { revenue: 50000, newUsers: 100, proConversions: 10 },
  })
  targets: {
    revenue: number;
    newUsers: number;
    proConversions: number;
  };
}

export class GetGoalsQueryDto {
  @ApiPropertyOptional({ description: 'Month in YYYY-MM format (defaults to current month)' })
  @IsOptional()
  @IsString()
  month?: string;
}

// ==================== Geography ====================

export class GetGeoRevenueQueryDto {
  @ApiProperty({ description: 'Start date (ISO string)' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date (ISO string)' })
  @IsDateString()
  endDate: string;
}

// ==================== Metrics ====================

export class GetChurnQueryDto {
  @ApiPropertyOptional({ description: 'Period (day, week, month)', default: 'month' })
  @IsOptional()
  @IsString()
  period?: string;
}

export class GetProfitQueryDto {
  @ApiProperty({ description: 'Start date (ISO string)' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date (ISO string)' })
  @IsDateString()
  endDate: string;
}
