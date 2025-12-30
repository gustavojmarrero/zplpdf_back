import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Resend } from 'resend';
import { FirestoreService } from '../cache/firestore.service.js';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { AdminUser } from '../../common/decorators/admin-user.decorator.js';
import type { EmailTemplate, TemplateVersion, TemplatePreview, EmailLanguage } from './interfaces/email.interface.js';
import {
  UpdateEmailTemplateDto,
  RollbackTemplateDto,
  TestEmailDto,
  EmailTemplateResponseDto,
  TemplateVersionResponseDto,
  TemplatePreviewResponseDto,
  TemplatesGroupedResponseDto,
  TestEmailResponseDto,
} from './dto/email-template.dto.js';

@ApiTags('email-templates')
@Controller('admin/email-templates')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
export class EmailTemplatesController {
  private readonly logger = new Logger(EmailTemplatesController.name);
  private readonly resend: Resend | null;
  private readonly fromEmail: string;
  private readonly isEnabled: boolean;

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly configService: ConfigService,
  ) {
    const featureEnabled = this.configService.get<string>('EMAIL_TEMPLATES_ADMIN_ENABLED') === 'true';
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL') || 'ZPLPDF <noreply@zplpdf.com>';
    this.isEnabled = featureEnabled;

    if (apiKey) {
      this.resend = new Resend(apiKey);
    } else {
      this.resend = null;
    }

    this.logger.log(`Email Templates Admin feature: ${featureEnabled ? 'enabled' : 'disabled'}`);
  }

  // ============== List All Templates ==============

  @Get()
  @ApiOperation({
    summary: 'List all email templates',
    description: 'Returns all email templates grouped by type',
  })
  @ApiResponse({
    status: 200,
    description: 'Templates retrieved successfully',
    type: TemplatesGroupedResponseDto,
  })
  async getTemplates(): Promise<TemplatesGroupedResponseDto> {
    const templates = await this.firestoreService.getEmailTemplates();

    const groupedBy = {
      pro_retention: templates.filter((t) => t.templateType === 'pro_retention'),
      free_reactivation: templates.filter((t) => t.templateType === 'free_reactivation'),
      onboarding: templates.filter((t) => t.templateType === 'onboarding'),
      conversion: templates.filter((t) => t.templateType === 'conversion'),
    };

    return { templates, groupedBy };
  }

  // ============== Get Template by ID ==============

  @Get(':id')
  @ApiOperation({
    summary: 'Get email template by ID',
    description: 'Returns a single email template with full details',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 200,
    description: 'Template retrieved successfully',
    type: EmailTemplateResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async getTemplate(@Param('id') id: string): Promise<EmailTemplate> {
    const template = await this.firestoreService.getEmailTemplateById(id);
    if (!template) {
      throw new NotFoundException(`Template with ID ${id} not found`);
    }
    return template;
  }

  // ============== Update Template ==============

  @Put(':id')
  @ApiOperation({
    summary: 'Update email template',
    description: 'Updates template content and creates a new version in history',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 200,
    description: 'Template updated successfully',
    type: EmailTemplateResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async updateTemplate(
    @Param('id') id: string,
    @Body() updateDto: UpdateEmailTemplateDto,
    @AdminUser() admin: { email: string },
  ): Promise<EmailTemplate> {
    const template = await this.firestoreService.updateEmailTemplate(id, {
      ...updateDto,
      updatedBy: admin.email,
    });

    if (!template) {
      throw new NotFoundException(`Template with ID ${id} not found`);
    }

    this.logger.log(`Template ${id} updated by ${admin.email}: ${updateDto.changeDescription}`);
    return template;
  }

  // ============== Get Version History ==============

  @Get(':id/history')
  @ApiOperation({
    summary: 'Get template version history',
    description: 'Returns all previous versions of the template',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 200,
    description: 'Version history retrieved successfully',
    type: [TemplateVersionResponseDto],
  })
  async getHistory(@Param('id') id: string): Promise<TemplateVersion[]> {
    // Verify template exists
    const template = await this.firestoreService.getEmailTemplateById(id);
    if (!template) {
      throw new NotFoundException(`Template with ID ${id} not found`);
    }

    return this.firestoreService.getTemplateVersionHistory(id);
  }

  // ============== Rollback Template ==============

  @Post(':id/rollback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rollback template to previous version',
    description: 'Restores template content from a previous version',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 200,
    description: 'Template rolled back successfully',
    type: EmailTemplateResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Template or version not found' })
  async rollbackTemplate(
    @Param('id') id: string,
    @Body() rollbackDto: RollbackTemplateDto,
    @AdminUser() admin: { email: string },
  ): Promise<EmailTemplate> {
    try {
      const template = await this.firestoreService.rollbackTemplate(
        id,
        rollbackDto.versionId,
        admin.email,
      );

      if (!template) {
        throw new NotFoundException(`Template with ID ${id} not found`);
      }

      this.logger.log(`Template ${id} rolled back to version ${rollbackDto.versionId} by ${admin.email}`);
      return template;
    } catch (error) {
      if (error.message.includes('not found')) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  // ============== Send Test Email ==============

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send test email',
    description: 'Sends a test email to the logged-in admin with sample data',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 200,
    description: 'Test email sent successfully',
    type: TestEmailResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async sendTestEmail(
    @Param('id') id: string,
    @Body() testDto: TestEmailDto,
    @AdminUser() admin: { email: string },
  ): Promise<TestEmailResponseDto> {
    const template = await this.firestoreService.getEmailTemplateById(id);
    if (!template) {
      throw new NotFoundException(`Template with ID ${id} not found`);
    }

    const { subject, body, sampleData } = this.generatePreview(template, testDto.language);

    if (!this.resend) {
      this.logger.warn('Resend not configured, test email not sent');
      return {
        success: false,
        message: 'Email service not configured (RESEND_API_KEY missing)',
      };
    }

    try {
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: admin.email,
        subject: `[TEST] ${subject}`,
        html: body,
      });

      this.logger.log(`Test email sent to ${admin.email} for template ${id}`);
      return {
        success: true,
        message: `Test email sent to ${admin.email}`,
        emailId: result.data?.id,
      };
    } catch (error) {
      this.logger.error(`Failed to send test email: ${error.message}`);
      return {
        success: false,
        message: `Failed to send test email: ${error.message}`,
      };
    }
  }

  // ============== Preview Template ==============

  @Get(':id/preview')
  @ApiOperation({
    summary: 'Get template preview',
    description: 'Returns rendered template with sample data',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiQuery({ name: 'language', enum: ['en', 'es', 'zh'], required: false })
  @ApiResponse({
    status: 200,
    description: 'Preview generated successfully',
    type: TemplatePreviewResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async getPreview(
    @Param('id') id: string,
    @Query('language') language: 'en' | 'es' | 'zh' = 'en',
  ): Promise<TemplatePreview> {
    const template = await this.firestoreService.getEmailTemplateById(id);
    if (!template) {
      throw new NotFoundException(`Template with ID ${id} not found`);
    }

    return this.generatePreview(template, language);
  }

  // ============== Helper Methods ==============

  private generatePreview(
    template: EmailTemplate,
    language: 'en' | 'es' | 'zh',
  ): TemplatePreview {
    const sampleData: Record<string, string | number> = {
      userName: 'John Doe',
      displayName: 'John Doe',
      daysInactive: template.triggerDays,
      daysSinceRegistration: template.triggerDays,
      pdfsUsed: 20,
      pdfsAvailable: 25,
      limit: 25,
      pdfCount: 20,
      labelCount: 150,
      appUrl: 'https://zplpdf.com',
      upgradeUrl: 'https://zplpdf.com/pricing',
      unsubscribeUrl: 'https://zplpdf.com/unsubscribe?token=sample',
    };

    const content = template.content[language] || template.content.en;
    let subject = content.subject;
    let body = content.body;

    // Replace variables
    for (const [key, value] of Object.entries(sampleData)) {
      const regex = new RegExp(`\\{${key}\\}`, 'g');
      subject = subject.replace(regex, String(value));
      body = body.replace(regex, String(value));
    }

    return { subject, body, sampleData };
  }
}
