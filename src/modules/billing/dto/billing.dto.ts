import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
}

export class InvoicesResponseDto {
  @ApiProperty({ type: [InvoiceDto] })
  invoices: InvoiceDto[];

  @ApiProperty()
  hasMore: boolean;
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
