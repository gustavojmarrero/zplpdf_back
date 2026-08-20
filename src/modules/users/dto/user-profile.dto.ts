import { ApiProperty } from '@nestjs/swagger';
import type { PlanType } from '../../../common/interfaces/user.interface.js';

export class UserProfileDto {
  @ApiProperty({ description: 'User ID (Firebase UID)' })
  id: string;

  @ApiProperty({ description: 'User email' })
  email: string;

  @ApiProperty({ description: 'Display name', required: false })
  displayName?: string;

  @ApiProperty({
    description:
      'Profile photo URL. Es la foto subida por el usuario si la hay; si no, la ' +
      'del proveedor de acceso (Google). Ausente cuando el usuario borró su foto ' +
      'y no hay ninguna del proveedor.',
    required: false,
  })
  photoURL?: string;

  @ApiProperty({ description: 'Whether the email is verified' })
  emailVerified: boolean;

  @ApiProperty({
    description: 'Current plan',
    enum: ['free', 'lite', 'pro', 'promax', 'enterprise'],
  })
  plan: PlanType;

  @ApiProperty({ description: 'Account creation date' })
  createdAt: Date;

  @ApiProperty({ description: 'Has active Stripe subscription' })
  hasStripeSubscription: boolean;
}
