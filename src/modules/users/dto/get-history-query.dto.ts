import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  IsDateString,
  Matches,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LabelSize } from '../../zpl/enums/label-size.enum.js';
import { OutputFormat } from '../../zpl/enums/output-format.enum.js';

/**
 * Formato extendido de ISO 8601: `YYYY-MM-DD` con hora y offset opcionales.
 *
 * `@IsDateString()` por sí solo es demasiado laxo para un filtro de rango: acepta
 * el separador espacio (`2026-01-20 12:00:00`), que `Date.parse` resuelve en la
 * zona local del proceso —el mismo filtro significaría cosas distintas en Cloud
 * Run y en Mérida—, y también el formato básico sin guiones (`20260120T120000Z`),
 * que `Date.parse` no entiende y devuelve `NaN`, dejando el límite ignorado en
 * silencio. Restringiendo aquí, lo que pasa la validación siempre parsea y
 * siempre significa lo mismo; el resto recibe un 400 explícito.
 */
export const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const ISO_DATE_MESSAGE =
  '$property must be YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.SSS]] with an optional Z or ±HH:MM offset';

const ISO_DATE_DESCRIPTION =
  'Formato YYYY-MM-DD o YYYY-MM-DDTHH:mm[:ss[.SSS]] con Z u offset ±HH:MM opcional. ' +
  'Sin zona horaria se interpreta como UTC.';

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
    description:
      'Free text, case-insensitive substring match over jobId, labelSize ' +
      'and outputFormat; also matched against labelCount when the term is ' +
      'numeric',
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
    description: `Filter by conversion date from (inclusive). ${ISO_DATE_DESCRIPTION}`,
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE })
  dateFrom?: string;

  @ApiPropertyOptional({
    description:
      `Filter by conversion date to (inclusive). ${ISO_DATE_DESCRIPTION} ` +
      'A date without time (YYYY-MM-DD) covers the whole day',
    example: '2026-01-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE })
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
