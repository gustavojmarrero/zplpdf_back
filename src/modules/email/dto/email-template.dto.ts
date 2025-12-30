import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsArray,
  IsObject,
  ValidateNested,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============== Content DTOs ==============

export class EmailContentDto {
  @ApiProperty({ example: 'Welcome to ZPLPDF!' })
  @IsString()
  subject: string;

  @ApiProperty({ example: '<html><body>Hello {userName}...</body></html>' })
  @IsString()
  body: string;
}

export class TemplateContentDto {
  @ApiPropertyOptional({ type: EmailContentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EmailContentDto)
  en?: EmailContentDto;

  @ApiPropertyOptional({ type: EmailContentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EmailContentDto)
  es?: EmailContentDto;

  @ApiPropertyOptional({ type: EmailContentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EmailContentDto)
  zh?: EmailContentDto;
}

// ============== Update Template DTO ==============

export class UpdateEmailTemplateDto {
  @ApiPropertyOptional({ type: TemplateContentDto, description: 'Email content by language' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateContentDto)
  content?: TemplateContentDto;

  @ApiPropertyOptional({ example: 7, description: 'Days of inactivity to trigger email' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(365)
  triggerDays?: number;

  @ApiPropertyOptional({ example: true, description: 'Whether template is enabled' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'Retention 7 Days', description: 'Template name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'Email sent after 7 days of inactivity' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'Updated subject line for better engagement', description: 'Description of the change' })
  @IsString()
  changeDescription: string;
}

// ============== Rollback DTO ==============

export class RollbackTemplateDto {
  @ApiProperty({ example: 'abc123xyz', description: 'Version ID to rollback to' })
  @IsString()
  versionId: string;
}

// ============== Test Email DTO ==============

export class TestEmailDto {
  @ApiProperty({ enum: ['en', 'es', 'zh'], example: 'en', description: 'Language for test email' })
  @IsEnum(['en', 'es', 'zh'])
  language: 'en' | 'es' | 'zh';
}

// ============== Response DTOs ==============

export class EmailTemplateResponseDto {
  @ApiProperty({ example: 'abc123' })
  id: string;

  @ApiProperty({ example: 'pro_retention' })
  templateType: string;

  @ApiProperty({ example: 'pro_inactive_7_days' })
  templateKey: string;

  @ApiProperty({ example: 'PRO Retention 7 Days' })
  name: string;

  @ApiProperty({ example: 'Email sent to PRO users after 7 days of inactivity' })
  description: string;

  @ApiProperty({ example: 7 })
  triggerDays: number;

  @ApiProperty({ example: true })
  enabled: boolean;

  @ApiProperty({
    example: {
      en: { subject: 'We miss you!', body: '<html>...</html>' },
      es: { subject: 'Te extrañamos!', body: '<html>...</html>' },
      zh: { subject: '我们想念你!', body: '<html>...</html>' },
    },
  })
  content: {
    en: { subject: string; body: string };
    es: { subject: string; body: string };
    zh: { subject: string; body: string };
  };

  @ApiProperty({ example: ['userName', 'daysInactive', 'appUrl'] })
  variables: string[];

  @ApiProperty({ example: '2025-12-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2025-12-30T15:30:00.000Z' })
  updatedAt: Date;

  @ApiProperty({ example: 'admin@zplpdf.com' })
  updatedBy: string;

  @ApiProperty({ example: 3 })
  version: number;
}

export class TemplateVersionResponseDto {
  @ApiProperty({ example: 'version123' })
  id: string;

  @ApiProperty({ example: 'template456' })
  templateId: string;

  @ApiProperty({ example: 2 })
  version: number;

  @ApiProperty()
  content: {
    en: { subject: string; body: string };
    es: { subject: string; body: string };
    zh: { subject: string; body: string };
  };

  @ApiProperty({ example: 7 })
  triggerDays: number;

  @ApiProperty({ example: true })
  enabled: boolean;

  @ApiProperty({ example: '2025-12-30T14:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: 'admin@zplpdf.com' })
  createdBy: string;

  @ApiProperty({ example: 'Updated subject line' })
  changeDescription: string;
}

export class TemplatePreviewResponseDto {
  @ApiProperty({ example: 'Hello John Doe, we miss you!' })
  subject: string;

  @ApiProperty({ example: '<html><body>Hello John Doe...</body></html>' })
  body: string;

  @ApiProperty({
    example: {
      userName: 'John Doe',
      daysInactive: 14,
      appUrl: 'https://zplpdf.com',
    },
  })
  sampleData: Record<string, string | number>;
}

export class TemplatesGroupedResponseDto {
  @ApiProperty({ type: [EmailTemplateResponseDto] })
  templates: EmailTemplateResponseDto[];

  @ApiProperty({
    example: {
      pro_retention: [],
      free_reactivation: [],
      onboarding: [],
      conversion: [],
    },
  })
  groupedBy: {
    pro_retention: EmailTemplateResponseDto[];
    free_reactivation: EmailTemplateResponseDto[];
    onboarding: EmailTemplateResponseDto[];
    conversion: EmailTemplateResponseDto[];
  };
}

export class TestEmailResponseDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'Test email sent to admin@zplpdf.com' })
  message: string;

  @ApiProperty({ example: 'resend-id-123', nullable: true })
  emailId?: string;
}
