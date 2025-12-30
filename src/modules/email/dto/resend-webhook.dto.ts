import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, IsArray } from 'class-validator';

/**
 * Data payload for Resend webhook events
 * IMPORTANT: This class must be defined BEFORE ResendWebhookDto to avoid
 * "Cannot access before initialization" error with ESM decorators
 */
export class ResendWebhookData {
  @ApiProperty({ example: 'ae123456-1234-1234-1234-123456789012', description: 'Resend email ID' })
  @IsString()
  email_id: string;

  @ApiPropertyOptional({ example: 'ZPLPDF <noreply@zplpdf.com>', description: 'From address' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ example: ['user@example.com'], description: 'To addresses' })
  @IsOptional()
  @IsArray()
  to?: string[];

  @ApiPropertyOptional({ example: 'Welcome to ZPLPDF!', description: 'Email subject' })
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional({ description: 'Clicked link data (for click events)' })
  @IsOptional()
  @IsObject()
  click?: {
    link: string;
  };
}

/**
 * Resend Webhook Event Types:
 * - email.sent: Email was sent
 * - email.delivered: Email was delivered
 * - email.delivery_delayed: Email delivery was delayed
 * - email.complained: Recipient marked email as spam
 * - email.bounced: Email bounced
 * - email.opened: Email was opened
 * - email.clicked: Link in email was clicked
 */
export class ResendWebhookDto {
  @ApiProperty({
    example: 'email.delivered',
    description: 'Type of webhook event',
    enum: [
      'email.sent',
      'email.delivered',
      'email.delivery_delayed',
      'email.complained',
      'email.bounced',
      'email.opened',
      'email.clicked',
    ],
  })
  @IsString()
  type: string;

  @ApiProperty({ example: '2024-01-15T10:30:00.000Z', description: 'Event timestamp' })
  @IsString()
  created_at: string;

  @ApiProperty({ description: 'Event data payload', type: ResendWebhookData })
  @IsObject()
  data: ResendWebhookData;
}
