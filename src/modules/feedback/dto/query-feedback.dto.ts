import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryFeedbackDto {
  @ApiPropertyOptional({ description: 'Número de página', default: 1 })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({ description: 'Resultados por página', default: 20 })
  @IsOptional()
  @IsString()
  limit?: string;

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
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Fecha de fin (ISO 8601)' })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Buscar en el mensaje o el email del usuario' })
  @IsOptional()
  @IsString()
  search?: string;
}
