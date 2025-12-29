import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Headers,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { EmailService } from './email.service.js';
import { CronAuthGuard } from '../../common/guards/cron-auth.guard.js';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { ResendWebhookDto } from './dto/resend-webhook.dto.js';
import { EmailMetricsDto, AbTestResultDto, EmailMetricsByTypeDto } from './dto/email-metrics.dto.js';
import type { ProcessQueueResult, ScheduleEmailsResult } from './interfaces/email.interface.js';

@ApiTags('email')
@Controller()
export class EmailController {
  private readonly logger = new Logger(EmailController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {
    this.webhookSecret = this.configService.get<string>('RESEND_WEBHOOK_SECRET') || '';
  }

  // ============== Cron Endpoints ==============

  @Post('cron/process-email-queue')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Process pending emails in queue (Cloud Scheduler)',
    description: 'Sends pending emails that are ready to be sent. Should run every 5 minutes.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Email queue processed',
    schema: {
      properties: {
        sent: { type: 'number', example: 5 },
        failed: { type: 'number', example: 0 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async processEmailQueue(): Promise<ProcessQueueResult> {
    return this.emailService.processQueue();
  }

  @Post('cron/schedule-onboarding-emails')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Schedule onboarding emails for eligible users (Cloud Scheduler)',
    description: 'Evaluates users for tutorial, help, and day 7 emails. Should run every hour.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Onboarding emails scheduled',
    schema: {
      properties: {
        tutorial: {
          type: 'object',
          properties: {
            scheduled: { type: 'number', example: 3 },
            skipped: { type: 'number', example: 0 },
          },
        },
        help: {
          type: 'object',
          properties: {
            scheduled: { type: 'number', example: 2 },
            skipped: { type: 'number', example: 0 },
          },
        },
        day7: {
          type: 'object',
          properties: {
            scheduled: { type: 'number', example: 1 },
            skipped: { type: 'number', example: 0 },
          },
        },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async scheduleOnboardingEmails(): Promise<{
    tutorial: ScheduleEmailsResult;
    help: ScheduleEmailsResult;
    day7: ScheduleEmailsResult;
    executedAt: Date;
  }> {
    const [tutorial, help, day7] = await Promise.all([
      this.emailService.scheduleTutorialEmails(),
      this.emailService.scheduleHelpEmails(),
      this.emailService.scheduleDay7Emails(),
    ]);

    return {
      tutorial,
      help,
      day7,
      executedAt: new Date(),
    };
  }

  @Post('cron/initialize-ab-variants')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Initialize A/B variant configurations (one-time setup)',
    description: 'Creates default A/B variant configurations in Firestore if they do not exist.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'A/B variants initialized',
  })
  async initializeAbVariants(): Promise<{ success: boolean; executedAt: Date }> {
    await this.emailService.initializeAbVariants();
    return { success: true, executedAt: new Date() };
  }

  // ============== Webhook Endpoint ==============

  @Post('webhooks/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Handle Resend webhook events',
    description: 'Receives delivery, open, click, bounce, and complaint events from Resend.',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook processed successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid webhook signature',
  })
  async handleResendWebhook(
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
    @Body() payload: ResendWebhookDto,
  ): Promise<{ received: boolean }> {
    // Verify webhook signature if secret is configured
    if (this.webhookSecret) {
      // For now, just log the signature headers
      // In production, you should verify using Svix library
      this.logger.debug(`Webhook received: ${payload.type} with svix-id: ${svixId}`);

      if (!svixId || !svixTimestamp || !svixSignature) {
        this.logger.warn('Missing webhook signature headers');
        // Don't throw - Resend may retry
      }
    }

    try {
      await this.emailService.handleWebhookEvent({
        type: payload.type,
        data: {
          email_id: payload.data.email_id,
          to: payload.data.to,
          click: payload.data.click,
        },
      });

      return { received: true };
    } catch (error) {
      this.logger.error(`Error handling webhook: ${error.message}`);
      // Return success to prevent retries for non-critical errors
      return { received: true };
    }
  }

  // ============== Admin Metrics Endpoints ==============

  @Get('api/admin/email-metrics')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get overall email metrics',
    description: 'Returns aggregated metrics for all onboarding emails including open and click rates.',
  })
  @ApiResponse({
    status: 200,
    description: 'Email metrics retrieved',
    type: EmailMetricsDto,
  })
  async getEmailMetrics(): Promise<EmailMetricsDto> {
    return this.emailService.getMetrics();
  }

  @Get('api/admin/email-metrics/ab-test')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get A/B test results',
    description: 'Returns metrics for each A/B variant by email type.',
  })
  @ApiQuery({
    name: 'emailType',
    required: false,
    description: 'Filter by email type (welcome, tutorial, help, success_story, miss_you)',
  })
  @ApiResponse({
    status: 200,
    description: 'A/B test results retrieved',
    type: [AbTestResultDto],
  })
  async getAbTestResults(
    @Query('emailType') emailType?: string,
  ): Promise<AbTestResultDto[]> {
    return this.emailService.getAbTestResults(emailType);
  }

  @Get('api/admin/email-metrics/by-type')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get email metrics by type',
    description: 'Returns metrics grouped by email type.',
  })
  @ApiResponse({
    status: 200,
    description: 'Email metrics by type retrieved',
    type: [EmailMetricsByTypeDto],
  })
  async getEmailMetricsByType(): Promise<EmailMetricsByTypeDto[]> {
    return this.emailService.getMetricsByType();
  }
}
