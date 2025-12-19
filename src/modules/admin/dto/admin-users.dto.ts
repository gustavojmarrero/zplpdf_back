import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Min, Max, IsEnum } from 'class-validator';
import { Transform, Type } from 'class-transformer';

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
