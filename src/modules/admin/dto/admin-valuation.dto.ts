import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

// ==================== Valuation Factor ====================

export class ValuationFactorDto {
  @ApiProperty({ description: 'Valor actual de la metrica' })
  value: number;

  @ApiProperty({ enum: ['positive', 'neutral', 'negative'], description: 'Impacto en el multiplo' })
  impact: 'positive' | 'neutral' | 'negative';

  @ApiProperty({ description: 'Peso del factor en el multiplo (1-5)' })
  weight: number;

  @ApiProperty({ description: 'Contribucion al multiplo (ej: +0.5x)' })
  contribution: number;

  @ApiProperty({ description: 'Explicacion del impacto' })
  explanation: string;
}

// ==================== Valuation Range ====================

export class ValuationRangeDto {
  @ApiProperty({ description: 'Escenario conservador' })
  low: number;

  @ApiProperty({ description: 'Escenario medio' })
  mid: number;

  @ApiProperty({ description: 'Escenario optimista' })
  high: number;
}

// ==================== Valuation Factors ====================

export class ValuationFactorsDto {
  @ApiProperty({ type: ValuationFactorDto })
  growthRate: ValuationFactorDto;

  @ApiProperty({ type: ValuationFactorDto })
  churnRate: ValuationFactorDto;

  @ApiProperty({ type: ValuationFactorDto })
  nrr: ValuationFactorDto;

  @ApiProperty({ type: ValuationFactorDto })
  profitMargin: ValuationFactorDto;

  @ApiProperty({ type: ValuationFactorDto })
  ruleOf40: ValuationFactorDto;
}

// ==================== Projection ====================

export class ValuationProjectionDto {
  @ApiProperty({ description: 'ARR proyectado a 12 meses (USD)' })
  arr12Months: number;

  @ApiProperty({ description: 'ARR proyectado a 12 meses (MXN)' })
  arr12MonthsMxn: number;

  @ApiProperty({ type: ValuationRangeDto, description: 'Valoracion proyectada a 12 meses (USD)' })
  valuation12Months: ValuationRangeDto;

  @ApiProperty({ type: ValuationRangeDto, description: 'Valoracion proyectada a 12 meses (MXN)' })
  valuation12MonthsMxn: ValuationRangeDto;

  @ApiProperty({ description: 'Supuesto de crecimiento anual (%)' })
  growthAssumption: number;
}

// ==================== Previous Month Comparison ====================

export class PreviousMonthComparisonDto {
  @ApiProperty({ description: 'Valoracion del mes anterior (mid, USD)' })
  valuation: number;

  @ApiProperty({ description: 'Valoracion del mes anterior (mid, MXN)' })
  valuationMxn: number;

  @ApiProperty({ description: 'Cambio porcentual vs mes anterior' })
  change: number;

  @ApiProperty({ enum: ['up', 'down', 'stable'], description: 'Direccion del cambio' })
  changeDirection: 'up' | 'down' | 'stable';

  @ApiProperty({ description: 'Mes de comparacion (YYYY-MM)' })
  month: string;
}

// ==================== Main Valuation Data ====================

export class BusinessValuationDataDto {
  @ApiProperty({ type: ValuationRangeDto, description: 'Valoracion en USD' })
  valuation: ValuationRangeDto;

  @ApiProperty({ type: ValuationRangeDto, description: 'Valoracion en MXN' })
  valuationMxn: ValuationRangeDto;

  @ApiProperty({ type: ValuationRangeDto, description: 'Multiplos aplicados' })
  multiple: ValuationRangeDto;

  @ApiProperty({ description: 'Annual Recurring Revenue (USD)' })
  arr: number;

  @ApiProperty({ description: 'Annual Recurring Revenue (MXN)' })
  arrMxn: number;

  @ApiProperty({ description: 'Monthly Recurring Revenue (USD)' })
  mrr: number;

  @ApiProperty({ description: 'Monthly Recurring Revenue (MXN)' })
  mrrMxn: number;

  @ApiProperty({ type: ValuationFactorsDto, description: 'Desglose de factores' })
  factors: ValuationFactorsDto;

  @ApiProperty({ description: 'Puntuacion de salud del negocio (0-100)' })
  healthScore: number;

  @ApiProperty({ enum: ['excellent', 'good', 'fair', 'poor'], description: 'Nivel de salud' })
  healthLevel: 'excellent' | 'good' | 'fair' | 'poor';

  @ApiProperty({ type: ValuationProjectionDto, description: 'Proyeccion a 12 meses' })
  projection: ValuationProjectionDto;

  @ApiPropertyOptional({ type: PreviousMonthComparisonDto, description: 'Comparacion con mes anterior' })
  previousMonth?: PreviousMonthComparisonDto;

  @ApiProperty({ description: 'Fecha de calculo' })
  calculatedAt: Date;

  @ApiProperty({ description: 'Metodologia usada' })
  methodology: string;

  @ApiProperty({ description: 'Tipo de cambio USD/MXN usado' })
  exchangeRate: number;
}

// ==================== Response ====================

export class BusinessValuationResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: BusinessValuationDataDto })
  data: BusinessValuationDataDto;
}

// ==================== History Item ====================

export class ValuationHistoryItemDto {
  @ApiProperty({ description: 'Mes (YYYY-MM)' })
  month: string;

  @ApiProperty({ description: 'ARR (USD)' })
  arr: number;

  @ApiProperty({ description: 'ARR (MXN)' })
  arrMxn: number;

  @ApiProperty({ description: 'Valoracion conservadora (USD)' })
  valuationLow: number;

  @ApiProperty({ description: 'Valoracion media (USD)' })
  valuationMid: number;

  @ApiProperty({ description: 'Valoracion optimista (USD)' })
  valuationHigh: number;

  @ApiProperty({ description: 'Multiplo medio' })
  multipleMid: number;

  @ApiProperty({ description: 'Health Score (0-100)' })
  healthScore: number;

  @ApiProperty({ description: 'Fecha de calculo' })
  calculatedAt: Date;
}

export class ValuationHistoryResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: [ValuationHistoryItemDto] })
  data: { history: ValuationHistoryItemDto[] };
}

// ==================== Query DTOs ====================

export class GetValuationHistoryQueryDto {
  @ApiPropertyOptional({ description: 'Numero de meses a obtener', default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(24)
  months?: number;
}
