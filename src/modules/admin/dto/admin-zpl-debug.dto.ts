import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsDateString,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

export class GetZplDebugFilesQueryDto {
  @ApiProperty({ description: 'User email to search for' })
  @IsEmail()
  email: string;

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

  @ApiPropertyOptional({ description: 'Start date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    enum: ['success', 'error'],
    description: 'Filter by conversion result',
  })
  @IsOptional()
  @IsString()
  result?: 'success' | 'error';
}

class ZplDebugFileDto {
  @ApiProperty({ description: 'Document ID' })
  id: string;

  @ApiProperty({ description: 'Job ID (conversion UUID)' })
  jobId: string;

  @ApiProperty({ description: 'User email' })
  userEmail: string;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Label size (e.g., "4x6")' })
  labelSize: string;

  @ApiProperty({ description: 'Number of labels in the ZPL' })
  labelCount: number;

  @ApiProperty({ description: 'File size in bytes' })
  fileSize: number;

  @ApiProperty({
    enum: ['pending', 'success', 'error'],
    description: 'Conversion result',
  })
  result: 'pending' | 'success' | 'error';

  @ApiPropertyOptional({ description: 'Error code if conversion failed' })
  errorCode?: string;

  @ApiProperty({
    enum: ['pdf', 'png', 'jpeg'],
    description: 'Output format requested',
  })
  outputFormat: string;
}

class ZplDebugFilesDataDto {
  @ApiProperty({ type: [ZplDebugFileDto] })
  files: ZplDebugFileDto[];

  @ApiProperty({ type: PaginationDto })
  pagination: PaginationDto;
}

export class AdminZplDebugFilesResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: ZplDebugFilesDataDto })
  data: ZplDebugFilesDataDto;
}

class ZplDebugFileMetadataDto {
  @ApiProperty()
  jobId: string;

  @ApiProperty()
  userEmail: string;

  @ApiProperty()
  labelSize: string;

  @ApiProperty()
  labelCount: number;

  @ApiProperty()
  fileSize: number;

  @ApiProperty()
  result: string;

  @ApiProperty()
  createdAt: string;
}

class ZplDebugFileDownloadDataDto {
  @ApiProperty({ description: 'Signed URL for download' })
  downloadUrl: string;

  @ApiProperty({ description: 'Filename for download' })
  filename: string;

  @ApiProperty({ description: 'URL expiration time' })
  expiresAt: string;

  @ApiProperty({ type: ZplDebugFileMetadataDto })
  metadata: ZplDebugFileMetadataDto;
}

export class AdminZplDebugFileDownloadResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: ZplDebugFileDownloadDataDto })
  data: ZplDebugFileDownloadDataDto;
}
