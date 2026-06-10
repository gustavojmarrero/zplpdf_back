import { IsIn, IsOptional, IsString, IsNumber, IsDateString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryFeedbackDto {
  @ApiPropertyOptional({ description: 'Número de página', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Resultados por página', default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: ['bad', 'neutral', 'good'], description: 'Filtrar por sentimiento' })
  @IsOptional()
  @IsIn(['bad', 'neutral', 'good'])
  sentiment?: 'bad' | 'neutral' | 'good';

  @ApiPropertyOptional({
    enum: ['free', 'lite', 'pro', 'promax', 'enterprise'],
    description: 'Filtrar por plan',
  })
  @IsOptional()
  @IsIn(['free', 'lite', 'pro', 'promax', 'enterprise'])
  plan?: string;

  @ApiPropertyOptional({ description: 'Fecha de inicio (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Fecha de fin (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Buscar en el mensaje o el email del usuario' })
  @IsOptional()
  @IsString()
  search?: string;
}
