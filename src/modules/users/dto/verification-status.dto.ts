import { ApiProperty } from '@nestjs/swagger';

export class VerificationStatusDto {
  @ApiProperty({ description: 'Whether the email is verified' })
  emailVerified: boolean;

  @ApiProperty({ description: 'User email address' })
  email: string;
}
