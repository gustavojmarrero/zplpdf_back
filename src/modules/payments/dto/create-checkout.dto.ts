import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn } from 'class-validator';

export class CreateCheckoutDto {
  @ApiProperty({
    description: 'Plan to subscribe to',
    required: false,
    enum: ['pro', 'promax'],
    default: 'pro',
  })
  @IsIn(['pro', 'promax'])
  @IsOptional()
  plan?: 'pro' | 'promax';

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
    description: 'Target plan to upgrade to',
    enum: ['promax'],
  })
  @IsIn(['promax'])
  targetPlan: 'promax';
}

export class UpgradeResponseDto {
  @ApiProperty({ description: 'Whether the upgrade was successful' })
  success: boolean;

  @ApiProperty({ description: 'Message describing the result' })
  message: string;
}
