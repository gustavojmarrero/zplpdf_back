import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, Matches } from 'class-validator';

export class PlansQueryDto {
  @ApiPropertyOptional({
    description:
      'Country code (ISO 3166-1 alpha-2). MX returns MXN prices; any other country, or none, returns USD.',
    example: 'MX',
  })
  @IsOptional()
  // Un `?country=` vacío se trata como ausente: la página de precios lo manda
  // así cuando aún no conoce el país, y eso no es un error del visitante.
  //
  // Sin pasar a mayúsculas a propósito: el checkout decide la moneda con el
  // país tal cual llega (`MX`), y normalizar solo aquí haría que `?country=mx`
  // pintara precios en MXN que luego se cobran en USD.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'country must be a two-letter ISO 3166-1 alpha-2 code',
  })
  country?: string;
}

export class PlanPriceDto {
  @ApiProperty({ description: 'Stripe price ID', example: 'price_123' })
  priceId: string;

  @ApiProperty({
    description: 'Amount in the smallest currency unit (cents), as in Stripe',
    example: 9900,
  })
  amount: number;

  @ApiProperty({ description: 'Formatted amount', example: '$99' })
  display: string;
}

export class YearlyPlanPriceDto extends PlanPriceDto {
  @ApiProperty({
    description:
      'Yearly amount divided by 12, rounded, in the smallest currency unit',
    example: 7917,
  })
  monthlyEquivalent: number;

  @ApiProperty({
    description:
      'Saving against paying the monthly price for 12 months, as a rounded percentage (never negative)',
    example: 20,
  })
  discountPercent: number;
}

export class PlanOfferDto {
  @ApiProperty({ enum: ['lite', 'pro', 'promax'] })
  plan: 'lite' | 'pro' | 'promax';

  @ApiProperty({ type: PlanPriceDto })
  monthly: PlanPriceDto;

  @ApiProperty({
    type: YearlyPlanPriceDto,
    nullable: true,
    description:
      'null while yearly billing is not available for this plan and currency: keep the yearly tab disabled',
  })
  yearly: YearlyPlanPriceDto | null;
}

export class PlansResponseDto {
  @ApiProperty({ enum: ['USD', 'MXN'] })
  currency: 'USD' | 'MXN';

  @ApiProperty({
    type: [PlanOfferDto],
    description:
      'Sellable plans in lite → pro → promax order. A plan without a valid monthly price is omitted.',
  })
  plans: PlanOfferDto[];
}
