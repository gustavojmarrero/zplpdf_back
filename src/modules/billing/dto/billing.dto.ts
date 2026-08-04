import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Estado del CFDI tal como lo pinta la UI.
 *
 * `not_applicable` es «se evaluó y este cobro no lleva comprobante» —una factura
 * anterior a que el usuario cargara su perfil fiscal, por ejemplo—. El campo
 * completo llega a `null` cuando el módulo no aplica: usuarios no mexicanos.
 */
export type CfdiApiStatus =
  | 'stamped'
  | 'pending'
  | 'failed'
  | 'canceled'
  | 'not_applicable';

export class CfdiErrorDto {
  @ApiProperty({
    description:
      'Código estable que traduce el frontend: rfc_not_found, name_mismatch, postal_code_mismatch, regime_mismatch, cfdi_use_invalid, pac_unavailable, invoice_not_stampable, unknown',
    example: 'rfc_not_found',
  })
  code: string;

  @ApiProperty({
    description:
      'Texto libre para logs y diagnóstico. La UI solo cae aquí si el código no está mapeado.',
  })
  message: string;
}

export class CfdiDto {
  @ApiProperty({
    enum: ['stamped', 'pending', 'failed', 'canceled', 'not_applicable'],
  })
  status: CfdiApiStatus;

  @ApiPropertyOptional({ nullable: true, description: 'Folio fiscal del SAT' })
  uuid: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'URL firmada, válida 15 minutos',
  })
  pdfUrl: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'URL firmada, válida 15 minutos',
  })
  xmlUrl: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO 8601' })
  stampedAt: string | null;

  @ApiPropertyOptional({ type: CfdiErrorDto, nullable: true })
  error: CfdiErrorDto | null;
}

// Invoice DTOs
export class InvoiceDto {
  @ApiProperty()
  id: string;

  @ApiPropertyOptional()
  number: string | null;

  @ApiProperty()
  status: string;

  @ApiProperty({ description: 'Amount in cents' })
  amountDue: number;

  @ApiProperty({ description: 'Amount in cents' })
  amountPaid: number;

  @ApiProperty()
  currency: string;

  @ApiProperty({ description: 'Unix timestamp' })
  created: number;

  @ApiProperty({ description: 'Unix timestamp' })
  periodStart: number;

  @ApiProperty({ description: 'Unix timestamp' })
  periodEnd: number;

  @ApiPropertyOptional()
  hostedInvoiceUrl: string | null;

  @ApiPropertyOptional()
  invoicePdf: string | null;

  @ApiPropertyOptional()
  description: string | null;

  @ApiPropertyOptional({
    type: CfdiDto,
    nullable: true,
    description:
      'CFDI asociado al cobro. `null` cuando el módulo no aplica (usuario no mexicano).',
  })
  cfdi?: CfdiDto | null;
}

export class InvoicesResponseDto {
  @ApiProperty({ type: [InvoiceDto] })
  invoices: InvoiceDto[];

  @ApiProperty()
  hasMore: boolean;
}

export class CfdiRetryResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: CfdiDto })
  cfdi: CfdiDto;
}

// Payment Method DTOs
export class CardDetailsDto {
  @ApiProperty()
  brand: string;

  @ApiProperty()
  last4: string;

  @ApiProperty()
  expMonth: number;

  @ApiProperty()
  expYear: number;
}

export class BillingDetailsDto {
  @ApiPropertyOptional()
  name: string | null;

  @ApiPropertyOptional()
  email: string | null;
}

export class PaymentMethodDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  type: string;

  @ApiProperty()
  card: CardDetailsDto;

  @ApiProperty()
  billingDetails: BillingDetailsDto;

  @ApiProperty()
  isDefault: boolean;
}

export class PaymentMethodsResponseDto {
  @ApiProperty({ type: [PaymentMethodDto] })
  paymentMethods: PaymentMethodDto[];

  @ApiPropertyOptional()
  defaultPaymentMethodId: string | null;
}

// Subscription DTOs
export class SubscriptionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  plan: string;

  @ApiProperty({ description: 'Unix timestamp' })
  currentPeriodStart: number;

  @ApiProperty({ description: 'Unix timestamp' })
  currentPeriodEnd: number;

  @ApiProperty()
  cancelAtPeriodEnd: boolean;

  @ApiPropertyOptional({ description: 'Unix timestamp' })
  canceledAt: number | null;

  @ApiPropertyOptional({ description: 'Amount in cents' })
  priceAmount: number | null;

  @ApiPropertyOptional()
  priceCurrency: string | null;

  @ApiPropertyOptional()
  interval: string | null;
}
