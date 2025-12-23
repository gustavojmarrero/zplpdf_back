import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsObject,
  MaxLength,
} from 'class-validator';

export class CreateErrorDto {
  @ApiProperty({
    description: 'Error code identifier',
    example: 'CONVERSION_FAILED',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code: string;

  @ApiProperty({
    description: 'Human-readable error message',
    example: 'Failed to convert ZPL to PDF',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;

  @ApiPropertyOptional({
    description: 'Error severity level',
    enum: ['error', 'warning', 'critical'],
    default: 'error',
  })
  @IsEnum(['error', 'warning', 'critical'])
  @IsOptional()
  severity?: 'error' | 'warning' | 'critical' = 'error';

  @ApiPropertyOptional({
    description: 'Error type/category',
    example: 'CONVERSION',
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({
    description: 'URL where the error occurred',
    example: 'https://app.zplpdf.com/convert',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  url?: string;

  @ApiPropertyOptional({
    description: 'Stack trace of the error',
  })
  @IsString()
  @IsOptional()
  @MaxLength(5000)
  stackTrace?: string;

  @ApiPropertyOptional({
    description: 'Additional context data (jobId, etc)',
    example: { jobId: 'abc123', labelCount: 5 },
  })
  @IsObject()
  @IsOptional()
  context?: Record<string, any>;
}

export class CreateErrorResponseDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({
    type: 'object',
    properties: {
      errorId: {
        type: 'string',
        example: 'ERR-20251222-00042',
        description: 'Unique error ID that can be communicated to support',
      },
      message: {
        type: 'string',
        example: 'Error registrado correctamente',
      },
    },
  })
  data: {
    errorId: string;
    message: string;
  };
}
