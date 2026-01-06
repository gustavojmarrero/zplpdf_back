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
import { FirestoreService } from '../cache/firestore.service.js';
import { CronAuthGuard } from '../../common/guards/cron-auth.guard.js';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { ResendWebhookDto } from './dto/resend-webhook.dto.js';
import { EmailMetricsDto, AbTestResultDto, EmailMetricsByTypeDto, OnboardingFunnelDto } from './dto/email-metrics.dto.js';
import type { ProcessQueueResult, ScheduleEmailsResult, ProInactiveUser, ProPowerUser, FreeReactivationResult, FreeInactiveUser, FreeInactiveUsersResponse, InactiveUsersResponse, PowerUsersResponse } from './interfaces/email.interface.js';

@ApiTags('email')
@Controller()
export class EmailController {
  private readonly logger = new Logger(EmailController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly emailService: EmailService,
    private readonly firestoreService: FirestoreService,
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

  @Post('cron/schedule-high-usage-emails')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Schedule high usage emails (Cloud Scheduler)',
    description: 'Identifies FREE users with high usage patterns and sends proactive upgrade emails. Should run daily.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'High usage emails scheduled',
    schema: {
      properties: {
        scheduled: { type: 'number', example: 5 },
        skipped: { type: 'number', example: 0 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async scheduleHighUsageEmails(): Promise<ScheduleEmailsResult> {
    return this.emailService.scheduleHighUsageEmails();
  }

  @Post('cron/schedule-retention-emails')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Schedule retention emails for inactive PRO users (Cloud Scheduler)',
    description: 'Identifies PRO users inactive for 7/14/30 days and queues retention emails. Should run daily. Disabled by default - set RETENTION_EMAILS_ENABLED=true to enable.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Retention emails scheduled',
    schema: {
      properties: {
        scheduled: { type: 'number', example: 5 },
        skipped: { type: 'number', example: 2 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async scheduleRetentionEmails(): Promise<ScheduleEmailsResult> {
    return this.emailService.scheduleRetentionEmails();
  }

  @Post('cron/schedule-power-user-emails')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Schedule power user recognition emails (Cloud Scheduler)',
    description: 'Identifies PRO users with >50 PDFs in the previous month and queues recognition emails. Should run monthly (1st of each month). Disabled by default - set RETENTION_EMAILS_ENABLED=true to enable.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Power user emails scheduled',
    schema: {
      properties: {
        scheduled: { type: 'number', example: 3 },
        skipped: { type: 'number', example: 0 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async schedulePowerUserEmails(): Promise<ScheduleEmailsResult> {
    return this.emailService.schedulePowerUserEmails();
  }

  // ============== API Endpoints ==============

  @Post('email/trigger-blocked')
  @UseGuards(CronAuthGuard) // Using CronAuthGuard for internal API calls
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger blocked email for a user',
    description: 'Called when a user attempts to convert but is blocked due to reaching their limit.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for API authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Email triggered successfully',
    schema: {
      properties: {
        success: { type: 'boolean', example: true },
        emailId: { type: 'string', example: 'abc123', nullable: true },
      },
    },
  })
  async triggerBlockedEmail(
    @Body() body: { userId: string },
  ): Promise<{ success: boolean; emailId: string | null }> {
    const emailId = await this.emailService.triggerBlockedEmail(body.userId);
    return { success: true, emailId };
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

  @Get('admin/email-metrics')
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

  @Get('admin/email-metrics/ab-test')
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

  @Get('admin/email-metrics/by-type')
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

  @Get('admin/email-metrics/funnel')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get onboarding funnel data',
    description: 'Returns funnel metrics from registration to activation, including email engagement.',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['day', 'week', 'month'],
    description: 'Time period for funnel data (default: month)',
  })
  @ApiResponse({
    status: 200,
    description: 'Onboarding funnel data retrieved',
    type: OnboardingFunnelDto,
  })
  async getOnboardingFunnel(
    @Query('period') period?: 'day' | 'week' | 'month',
  ): Promise<OnboardingFunnelDto> {
    return this.emailService.getFunnel(period || 'month');
  }

  // ============== PRO User Admin Endpoints ==============

  @Get('admin/users/pro/inactive')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get inactive PRO users',
    description: 'Returns PRO users who have not used the service for a specified number of days.',
  })
  @ApiQuery({
    name: 'minDaysInactive',
    required: false,
    type: Number,
    description: 'Minimum days of inactivity (default: 7)',
  })
  @ApiQuery({
    name: 'maxDaysInactive',
    required: false,
    type: Number,
    description: 'Maximum days of inactivity (optional)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number for pagination (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of users per page (default: 50)',
  })
  @ApiResponse({
    status: 200,
    description: 'Inactive PRO users retrieved',
    schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              userEmail: { type: 'string' },
              displayName: { type: 'string', nullable: true },
              daysInactive: { type: 'number' },
              lastActivityAt: { type: 'string', format: 'date-time', nullable: true },
              pdfsThisMonth: { type: 'number' },
              labelsThisMonth: { type: 'number' },
              emailsSent: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        summary: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            byPeriod: {
              type: 'object',
              properties: {
                days7: { type: 'number' },
                days14: { type: 'number' },
                days30: { type: 'number' },
              },
            },
            byPlan: {
              type: 'object',
              properties: {
                pro: { type: 'number' },
                promax: { type: 'number' },
                enterprise: { type: 'number' },
              },
            },
          },
        },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            limit: { type: 'number' },
            total: { type: 'number' },
            totalPages: { type: 'number' },
          },
        },
      },
    },
  })
  async getInactiveProUsers(
    @Query('minDaysInactive') minDaysInactive?: string,
    @Query('maxDaysInactive') maxDaysInactive?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<InactiveUsersResponse> {
    return this.firestoreService.getProInactiveUsers({
      minDaysInactive: minDaysInactive ? parseInt(minDaysInactive, 10) : 7,
      maxDaysInactive: maxDaysInactive ? parseInt(maxDaysInactive, 10) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Get('admin/users/pro/power-users')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get PRO power users',
    description: 'Returns users in the top percentile of usage based on their individual billing period (default: top 10%).',
  })
  @ApiQuery({
    name: 'minPercentile',
    required: false,
    type: Number,
    description: 'Minimum percentile to qualify as power user (default: 90, meaning top 10%)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number for pagination (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of users per page (default: 50)',
  })
  @ApiResponse({
    status: 200,
    description: 'PRO power users retrieved',
    schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              userEmail: { type: 'string' },
              displayName: { type: 'string', nullable: true },
              pdfsThisMonth: { type: 'number' },
              labelsThisMonth: { type: 'number' },
              monthsAsPro: { type: 'number' },
            },
          },
        },
        summary: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            topPerformers: { type: 'number' },
            avgMonthlyPdfs: { type: 'number' },
            byPlan: {
              type: 'object',
              properties: {
                free: { type: 'number' },
                pro: { type: 'number' },
                promax: { type: 'number' },
                enterprise: { type: 'number' },
              },
            },
          },
        },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            limit: { type: 'number' },
            total: { type: 'number' },
            totalPages: { type: 'number' },
          },
        },
      },
    },
  })
  async getPowerUsers(
    @Query('minPercentile') minPercentile?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<PowerUsersResponse> {
    return this.emailService.getPowerUsersWithPeriod({
      minPercentile: minPercentile ? parseInt(minPercentile, 10) : 90,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  // ============== FREE User Reactivation Endpoints ==============

  @Post('cron/schedule-free-reactivation-emails')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Schedule reactivation emails for inactive FREE users (Cloud Scheduler)',
    description: 'Identifies FREE users based on inactivity segments and queues reactivation emails. Should run daily. Disabled by default - set FREE_REACTIVATION_EMAILS_ENABLED=true to enable.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'FREE reactivation emails scheduled',
    schema: {
      properties: {
        processed: { type: 'number', example: 50 },
        emailsScheduled: { type: 'number', example: 15 },
        byType: {
          type: 'object',
          properties: {
            free_never_used_7d: { type: 'number', example: 5 },
            free_never_used_14d: { type: 'number', example: 3 },
            free_tried_abandoned: { type: 'number', example: 2 },
            free_dormant_30d: { type: 'number', example: 3 },
            free_abandoned_60d: { type: 'number', example: 2 },
          },
        },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async scheduleFreeReactivationEmails(): Promise<FreeReactivationResult> {
    return this.emailService.scheduleFreeReactivationEmails();
  }

  @Get('admin/users/free/inactive')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get inactive FREE users',
    description: 'Returns FREE users who have not used the service, segmented by inactivity type.',
  })
  @ApiQuery({
    name: 'segment',
    required: false,
    enum: ['never_used', 'tried_abandoned', 'dormant', 'abandoned'],
    description: 'Filter by user segment',
  })
  @ApiQuery({
    name: 'minDaysInactive',
    required: false,
    type: Number,
    description: 'Minimum days of inactivity',
  })
  @ApiQuery({
    name: 'maxDaysInactive',
    required: false,
    type: Number,
    description: 'Maximum days of inactivity',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number for pagination (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of users per page (default: 100)',
  })
  @ApiResponse({
    status: 200,
    description: 'Inactive FREE users retrieved',
    schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              userEmail: { type: 'string' },
              displayName: { type: 'string', nullable: true },
              language: { type: 'string', enum: ['en', 'es', 'zh'] },
              registeredAt: { type: 'string', format: 'date-time' },
              lastActiveAt: { type: 'string', format: 'date-time', nullable: true },
              daysSinceRegistration: { type: 'number' },
              daysInactive: { type: 'number' },
              pdfCount: { type: 'number' },
              labelCount: { type: 'number' },
              segment: { type: 'string', enum: ['never_used', 'tried_abandoned', 'dormant', 'abandoned'] },
              emailsSent: { type: 'array', items: { type: 'string' } },
              lastEmailSentAt: { type: 'string', format: 'date-time', nullable: true },
              lastEmailType: { type: 'string', nullable: true },
            },
          },
        },
        summary: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            bySegment: {
              type: 'object',
              properties: {
                never_used: { type: 'number' },
                tried_abandoned: { type: 'number' },
                dormant: { type: 'number' },
                abandoned: { type: 'number' },
              },
            },
          },
        },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            limit: { type: 'number' },
            total: { type: 'number' },
            totalPages: { type: 'number' },
          },
        },
      },
    },
  })
  async getInactiveFreeUsers(
    @Query('segment') segment?: 'never_used' | 'tried_abandoned' | 'dormant' | 'abandoned',
    @Query('minDaysInactive') minDaysInactive?: string,
    @Query('maxDaysInactive') maxDaysInactive?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<FreeInactiveUsersResponse> {
    return this.firestoreService.getFreeInactiveUsers({
      segment,
      minDaysInactive: minDaysInactive ? parseInt(minDaysInactive, 10) : undefined,
      maxDaysInactive: maxDaysInactive ? parseInt(maxDaysInactive, 10) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 100,
    });
  }
}
