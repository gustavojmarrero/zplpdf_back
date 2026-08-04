import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { TaxProfileType } from '../../../common/interfaces/tax-profile.interface.js';

export class TaxProfileAddressDto {
  @ApiProperty({ example: 'Calle Mayor 1' })
  @IsString()
  @IsNotEmpty()
  line1: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  line2?: string | null;

  @ApiProperty({ example: 'Madrid' })
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  state?: string | null;

  @ApiProperty({ example: '28001' })
  @IsString()
  @IsNotEmpty()
  postalCode: string;

  @ApiProperty({ example: 'ES', description: 'ISO 3166-1 alpha-2' })
  @IsString()
  @Length(2, 2)
  country: string;
}

/**
 * Body de `PUT /billing/tax-profile`.
 *
 * Un solo DTO con validación condicional en vez de dos: class-validator no
 * resuelve uniones discriminadas, y partir el endpoint en dos rutas obligaría al
 * frontend a saber qué formulario le toca antes de preguntarlo.
 *
 * Las reglas fiscales de fondo (coherencia RFC ↔ régimen ↔ uso de CFDI) no caben
 * en decoradores y viven en `BillingService.validateTaxProfile`.
 */
export class UpdateTaxProfileDto {
  @ApiProperty({ enum: ['mx', 'international'] })
  @IsIn(['mx', 'international'])
  type: TaxProfileType;

  // ---- México ----

  @ApiPropertyOptional({
    example: 'XAXX010101000',
    description: 'Solo type=mx',
  })
  @ValidateIf((o: UpdateTaxProfileDto) => o.type === 'mx')
  @IsString()
  @IsNotEmpty()
  rfc?: string;

  @ApiPropertyOptional({
    example: '601',
    description: 'c_RegimenFiscal. Solo type=mx',
  })
  @ValidateIf((o: UpdateTaxProfileDto) => o.type === 'mx')
  @IsString()
  @IsNotEmpty()
  taxRegime?: string;

  @ApiPropertyOptional({
    example: 'G03',
    description: 'c_UsoCFDI. Solo type=mx',
  })
  @ValidateIf((o: UpdateTaxProfileDto) => o.type === 'mx')
  @IsString()
  @IsNotEmpty()
  cfdiUse?: string;

  @ApiPropertyOptional({
    example: '97000',
    description: 'CP del domicilio fiscal. Solo type=mx',
  })
  @ValidateIf((o: UpdateTaxProfileDto) => o.type === 'mx')
  @IsString()
  @IsNotEmpty()
  postalCode?: string;

  // ---- Comunes ----

  @ApiProperty({
    example: 'EMPRESA DEMO',
    description: 'Razón social sin régimen de capital',
  })
  @IsString()
  @IsNotEmpty()
  legalName: string;

  @ApiProperty({ example: 'facturas@empresa.com' })
  @IsEmail()
  billingEmail: string;

  // ---- Internacional ----

  @ApiPropertyOptional({
    example: 'eu_vat',
    nullable: true,
    description: 'Tipo de tax ID de Stripe. Solo type=international',
  })
  @IsOptional()
  @IsString()
  taxIdType?: string | null;

  @ApiPropertyOptional({
    example: 'ESB12345678',
    nullable: true,
    description: 'Solo type=international',
  })
  @IsOptional()
  @IsString()
  taxIdValue?: string | null;

  @ApiPropertyOptional({
    type: TaxProfileAddressDto,
    description: 'Domicilio fiscal. Solo type=international',
  })
  @ValidateIf((o: UpdateTaxProfileDto) => o.type === 'international')
  @IsObject()
  @ValidateNested()
  @Type(() => TaxProfileAddressDto)
  address?: TaxProfileAddressDto;
}

export class TaxProfileResponseDto {
  @ApiProperty({ enum: ['mx', 'international'] })
  type: TaxProfileType;

  @ApiProperty({ example: 'MX', description: 'ISO 3166-1 alpha-2' })
  country: string;

  @ApiProperty({
    description:
      'false cuando el usuario todavía no ha cargado su perfil. No es un 404: el frontend necesita `type` para saber qué formulario renderizar.',
  })
  isComplete: boolean;

  @ApiPropertyOptional()
  rfc?: string;

  @ApiPropertyOptional()
  legalName?: string;

  @ApiPropertyOptional({ description: 'c_RegimenFiscal' })
  taxRegime?: string;

  @ApiPropertyOptional()
  postalCode?: string;

  @ApiPropertyOptional({ description: 'c_UsoCFDI' })
  cfdiUse?: string;

  @ApiPropertyOptional()
  billingEmail?: string;

  @ApiPropertyOptional({ nullable: true })
  taxIdType?: string | null;

  @ApiPropertyOptional({ nullable: true })
  taxIdValue?: string | null;

  @ApiPropertyOptional({ type: TaxProfileAddressDto, nullable: true })
  address?: TaxProfileAddressDto | null;

  @ApiPropertyOptional({ description: 'ISO 8601' })
  updatedAt?: string;
}
