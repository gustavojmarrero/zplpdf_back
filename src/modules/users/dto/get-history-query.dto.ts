import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsDateString,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LabelSize } from '../../zpl/enums/label-size.enum.js';
import { OutputFormat } from '../../zpl/enums/output-format.enum.js';

export enum HistoryStatus {
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum HistorySortBy {
  CREATED_AT = 'createdAt',
  LABEL_COUNT = 'labelCount',
}

export enum HistorySortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class GetHistoryQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    default: 25,
    minimum: 1,
    maximum: 100,
    description: 'Items per page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  @ApiPropertyOptional({
    description: 'Free text over jobId (prefix match, case-insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: HistoryStatus })
  @IsOptional()
  @IsEnum(HistoryStatus)
  status?: HistoryStatus;

  @ApiPropertyOptional({ enum: OutputFormat })
  @IsOptional()
  @IsEnum(OutputFormat)
  outputFormat?: OutputFormat;

  /**
   * No se valida contra `LabelSize`: las conversiones batch guardan el tamaño
   * tal cual llega (`BatchConvertDto.labelSize` es un string libre), así que el
   * historial contiene valores fuera del enum (`small`, `large`, `4x4`…). Como
   * `facets.labelSizes` los expone para poblar el select del frontend, un enum
   * estricto rechazaría con 400 el propio valor que el endpoint acaba de
   * ofrecer. Un tamaño inexistente simplemente no devuelve resultados.
   */
  @ApiPropertyOptional({
    description: `Label size, e.g. ${Object.values(LabelSize).join(', ')}. Acepta cualquiera de los valores listados en facets.labelSizes`,
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  labelSize?: string;

  @ApiPropertyOptional({
    description: 'Filter by conversion date from (ISO 8601, inclusive)',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description:
      'Filter by conversion date to (ISO 8601, inclusive). A date without time ' +
      '(YYYY-MM-DD) covers the whole day',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    enum: HistorySortBy,
    default: HistorySortBy.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(HistorySortBy)
  sortBy?: HistorySortBy = HistorySortBy.CREATED_AT;

  @ApiPropertyOptional({
    enum: HistorySortOrder,
    default: HistorySortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(HistorySortOrder)
  sortOrder?: HistorySortOrder = HistorySortOrder.DESC;
}
