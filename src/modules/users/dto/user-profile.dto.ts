import { ApiProperty } from '@nestjs/swagger';
import type { PlanType } from '../../../common/interfaces/user.interface.js';

export class UserProfileDto {
  @ApiProperty({ description: 'User ID (Firebase UID)' })
  id: string;

  @ApiProperty({ description: 'User email' })
  email: string;

  @ApiProperty({ description: 'Display name', required: false })
  displayName?: string;

  @ApiProperty({ description: 'Whether the email is verified' })
  emailVerified: boolean;

  @ApiProperty({ description: 'Current plan', enum: ['free', 'pro', 'promax', 'enterprise'] })
  plan: PlanType;

  @ApiProperty({ description: 'Account creation date' })
  createdAt: Date;

  @ApiProperty({ description: 'Has active Stripe subscription' })
  hasStripeSubscription: boolean;
}
