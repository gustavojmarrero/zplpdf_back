import { Controller, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import {
  CronService,
  ResetUsageResult,
  CleanupErrorsResult,
  UpdateExchangeRateResult,
  GenerateRecurringExpensesResult,
  UpdateGoalsResult,
  CheckInactiveUsersResult,
  MigrateSubscriptionPeriodsResult,
  ResetUSCountriesResult,
} from './cron.service.js';
import { CronAuthGuard } from '../../common/guards/cron-auth.guard.js';

@ApiTags('cron')
@Controller('cron')
export class CronController {
  constructor(private readonly cronService: CronService) {}

  @Post('reset-usage')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset expired user usage periods (Cloud Scheduler)' })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Usage reset completed',
    schema: {
      properties: {
        resetCount: { type: 'number', example: 5 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async resetUsage(): Promise<ResetUsageResult> {
    return this.cronService.resetExpiredUsage();
  }

  @Post('cleanup-errors')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete errors older than 90 days (Cloud Scheduler)',
    description: 'Removes error logs that are older than 90 days to maintain database hygiene.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Error cleanup completed',
    schema: {
      properties: {
        deletedCount: { type: 'number', example: 15 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async cleanupErrors(): Promise<CleanupErrorsResult> {
    return this.cronService.cleanupOldErrors();
  }

  @Post('update-exchange-rates')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update USD/MXN exchange rate from Banxico (Cloud Scheduler)',
    description: 'Fetches the latest exchange rate from Banxico API and caches it. Should run daily at 6:00 AM (GMT-6).',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Exchange rate update completed',
    schema: {
      properties: {
        success: { type: 'boolean', example: true },
        rate: { type: 'number', example: 17.25 },
        source: { type: 'string', example: 'banxico' },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async updateExchangeRates(): Promise<UpdateExchangeRateResult> {
    return this.cronService.updateExchangeRate();
  }

  @Post('generate-recurring-expenses')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate recurring expenses (Cloud Scheduler)',
    description: 'Auto-generates charges for recurring expenses that are due today. Should run daily at 00:05 (GMT-6).',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Recurring expenses generated',
    schema: {
      properties: {
        generated: { type: 'number', example: 3 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async generateRecurringExpenses(): Promise<GenerateRecurringExpensesResult> {
    return this.cronService.generateRecurringExpenses();
  }

  @Post('update-goals')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update monthly goals progress (Cloud Scheduler)',
    description: 'Updates the actual values for the current month goals. Should run every hour.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Goals progress updated',
    schema: {
      properties: {
        month: { type: 'string', example: '2025-01' },
        updated: { type: 'boolean', example: true },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async updateGoals(): Promise<UpdateGoalsResult> {
    return this.cronService.updateGoals();
  }

  @Post('check-inactive-users')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check inactive users and send GA4 events (Cloud Scheduler)',
    description:
      'Detects users inactive for 7 or 30 days and sends events to GA4 for email reactivation flows. Should run daily at 08:00 (GMT-6).',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Inactive users check completed',
    schema: {
      properties: {
        notified7Days: { type: 'number', example: 5 },
        notified30Days: { type: 'number', example: 2 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async checkInactiveUsers(): Promise<CheckInactiveUsersResult> {
    return this.cronService.checkInactiveUsers();
  }

  @Post('migrate-subscription-periods')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Migrate subscription periods from Stripe to Firestore (one-time)',
    description:
      'For PRO/Promax users, fetches current_period_start/end from Stripe and stores in Firestore. This eliminates real-time Stripe calls for billing period calculation.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Migration completed',
    schema: {
      properties: {
        updated: { type: 'number', example: 24 },
        skipped: { type: 'number', example: 5 },
        errors: { type: 'number', example: 0 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async migrateSubscriptionPeriods(): Promise<MigrateSubscriptionPeriodsResult> {
    return this.cronService.migrateSubscriptionPeriods();
  }

  @Post('reset-us-countries')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset users with country US to unknown (one-time)',
    description:
      'Fixes users incorrectly assigned to "US" by changing their country to "unknown". Issue #69.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Migration completed',
    schema: {
      properties: {
        updated: { type: 'number', example: 156 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async resetUSCountries(): Promise<ResetUSCountriesResult> {
    return this.cronService.resetUSCountries();
  }
}
