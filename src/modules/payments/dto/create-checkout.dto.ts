import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn } from 'class-validator';

export class CreateCheckoutDto {
  @ApiProperty({
    description: 'Plan to subscribe to',
    required: false,
    enum: ['lite', 'pro', 'promax'],
    default: 'pro',
  })
  @IsIn(['lite', 'pro', 'promax'])
  @IsOptional()
  plan?: 'lite' | 'pro' | 'promax';

  @ApiProperty({
    description: 'URL to redirect after successful checkout',
    required: false,
  })
  @IsString()
  @IsOptional()
  successUrl?: string;

  @ApiProperty({
    description: 'URL to redirect after cancelled checkout',
    required: false,
  })
  @IsString()
  @IsOptional()
  cancelUrl?: string;

  @ApiProperty({
    description: 'Country code (ISO 3166-1 alpha-2) for currency selection',
    required: false,
    example: 'MX',
  })
  @IsString()
  @IsOptional()
  country?: string;

  @ApiProperty({
    description:
      'Billing period. `yearly` returns 400 with `data.code: YEARLY_BILLING_NOT_AVAILABLE` ' +
      'while the yearly price is not configured; it never falls back to monthly.',
    required: false,
    enum: ['monthly', 'yearly'],
    default: 'monthly',
  })
  @IsIn(['monthly', 'yearly'])
  @IsOptional()
  billingPeriod?: 'monthly' | 'yearly';
}

export class CheckoutResponseDto {
  @ApiProperty({ description: 'Stripe Checkout URL' })
  checkoutUrl: string;

  @ApiProperty({ description: 'Stripe Session ID' })
  sessionId: string;
}

export class PortalResponseDto {
  @ApiProperty({ description: 'Stripe Customer Portal URL' })
  portalUrl: string;
}

export class UpgradeSubscriptionDto {
  @ApiProperty({
    description:
      'Target plan. It may equal the current plan when moving from monthly to yearly billing.',
    enum: ['lite', 'pro', 'promax'],
  })
  @IsIn(['lite', 'pro', 'promax'])
  targetPlan: 'lite' | 'pro' | 'promax';

  @ApiProperty({
    description: 'Target billing period',
    required: false,
    enum: ['monthly', 'yearly'],
    default: 'monthly',
  })
  @IsIn(['monthly', 'yearly'])
  @IsOptional()
  billingPeriod?: 'monthly' | 'yearly';
}

export class UpgradeResponseDto {
  @ApiProperty({ description: 'Whether the upgrade was successful' })
  success: boolean;

  @ApiProperty({ description: 'Message describing the result' })
  message: string;
}
