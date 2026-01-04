import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { FirestoreService } from '../cache/firestore.service.js';
import type {
  EmailType,
  AbVariant,
  EmailLanguage,
  ProcessQueueResult,
  ScheduleEmailsResult,
  FreeReactivationResult,
  ReactivationEmailType,
} from './interfaces/email.interface.js';
import { getEmailTemplate } from './templates/email-templates.js';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend;
  private readonly fromEmail: string;
  private readonly isEnabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly firestoreService: FirestoreService,
  ) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL') || 'ZPLPDF <noreply@zplpdf.com>';
    this.isEnabled = !!apiKey;

    if (this.isEnabled) {
      this.resend = new Resend(apiKey);
      this.logger.log('Email service initialized with Resend');
    } else {
      this.logger.warn('Email service disabled: RESEND_API_KEY not configured');
    }
  }

  /**
   * Queue a welcome email for a new user
   * Called from UsersService.syncUser() when a new user is created
   */
  async queueWelcomeEmail(user: {
    id: string;
    email: string;
    displayName?: string;
    language?: string;
  }): Promise<string | null> {
    if (!this.isEnabled) {
      this.logger.debug('Email service disabled, skipping welcome email');
      return null;
    }

    try {
      // Check if user already has a welcome email
      const hasEmail = await this.firestoreService.hasUserReceivedEmail(user.id, 'welcome');
      if (hasEmail) {
        this.logger.debug(`User ${user.id} already has welcome email, skipping`);
        return null;
      }

      // Select A/B variant deterministically based on userId
      const variant = this.selectAbVariant(user.id);
      const language = (user.language as EmailLanguage) || 'en';

      // Schedule for immediate delivery
      const emailId = await this.firestoreService.createEmailQueue({
        userId: user.id,
        userEmail: user.email,
        emailType: 'welcome',
        abVariant: variant,
        language,
        scheduledFor: new Date(),
        metadata: { displayName: user.displayName },
      });

      this.logger.log(`Welcome email queued for user ${user.id} (variant ${variant})`);
      return emailId;
    } catch (error) {
      this.logger.error(`Failed to queue welcome email for ${user.id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Select A/B variant deterministically based on userId
   * Uses simple hash to ensure same user always gets same variant
   */
  selectAbVariant(userId: string): AbVariant {
    // Simple hash: sum of char codes mod 2
    const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return hash % 2 === 0 ? 'A' : 'B';
  }

  /**
   * Process pending emails in the queue
   * Called by cron job every 5 minutes
   */
  async processQueue(): Promise<ProcessQueueResult> {
    if (!this.isEnabled) {
      return { sent: 0, failed: 0, executedAt: new Date() };
    }

    const startTime = Date.now();
    let sent = 0;
    let failed = 0;

    try {
      const pendingEmails = await this.firestoreService.getPendingEmails(50);
      this.logger.log(`Processing ${pendingEmails.length} pending emails`);

      for (const email of pendingEmails) {
        try {
          await this.sendEmail(email);
          sent++;
        } catch (error) {
          this.logger.error(`Failed to send email ${email.id}: ${error.message}`);
          failed++;
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(`Email queue processed in ${duration}ms: ${sent} sent, ${failed} failed`);
    } catch (error) {
      this.logger.error(`Error processing email queue: ${error.message}`);
    }

    return { sent, failed, executedAt: new Date() };
  }

  /**
   * Replace template variables with actual values
   * Supports {variableName} syntax
   */
  private replaceVariables(text: string, data: Record<string, any>): string {
    return text.replace(/\{(\w+)\}/g, (match, key) => {
      return data[key] !== undefined ? String(data[key]) : match;
    });
  }

  /**
   * Send a single email from the queue
   */
  private async sendEmail(queueItem: {
    id: string;
    userId: string;
    userEmail: string;
    emailType: string;
    abVariant: string;
    language: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      let subject: string;
      let html: string;
      let text: string | undefined;

      // Try to get template from Firestore first
      const firestoreTemplate = await this.firestoreService.getEmailTemplateByKey(queueItem.emailType);

      if (firestoreTemplate?.content) {
        // Use content from Firestore (editable via frontend)
        const lang = queueItem.language as EmailLanguage;
        const content = firestoreTemplate.content[lang] || firestoreTemplate.content.en;

        // Prepare template data with all available variables
        const templateData = {
          displayName: queueItem.metadata?.displayName || 'there',
          userName: queueItem.metadata?.displayName || 'there',
          email: queueItem.userEmail,
          ...queueItem.metadata,
        };

        subject = this.replaceVariables(content.subject, templateData);
        html = this.replaceVariables(content.body, templateData);
        // Generate plain text from HTML (simple strip tags)
        text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      } else {
        // Fallback to hardcoded template (legacy support)
        const template = getEmailTemplate(
          queueItem.emailType as EmailType,
          queueItem.abVariant as AbVariant,
          queueItem.language as EmailLanguage,
          {
            displayName: queueItem.metadata?.displayName || 'there',
            email: queueItem.userEmail,
          },
        );
        subject = template.subject;
        html = template.html;
        text = template.text;
      }

      // Send via Resend
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: queueItem.userEmail,
        subject,
        html,
        text,
        tags: [
          { name: 'email_type', value: queueItem.emailType },
          { name: 'ab_variant', value: queueItem.abVariant },
          { name: 'user_id', value: queueItem.userId },
        ],
      });

      // Update queue status
      await this.firestoreService.updateEmailQueueStatus(
        queueItem.id,
        'sent',
        result.data?.id,
      );

      this.logger.debug(`Email sent to ${queueItem.userEmail}: ${result.data?.id}`);
    } catch (error) {
      // Update queue status with error
      await this.firestoreService.updateEmailQueueStatus(
        queueItem.id,
        'failed',
        undefined,
        error.message,
      );
      throw error;
    }
  }

  /**
   * Schedule tutorial emails for users who haven't converted after 24 hours
   * Called by cron job every hour
   */
  async scheduleTutorialEmails(): Promise<ScheduleEmailsResult> {
    if (!this.isEnabled) {
      return { scheduled: 0, skipped: 0, executedAt: new Date() };
    }

    let scheduled = 0;
    let skipped = 0;

    try {
      // Get users created 1 day ago with 0 PDFs
      const eligibleUsers = await this.firestoreService.getUsersEligibleForEmail({
        emailType: 'tutorial',
        minDaysSinceCreation: 1,
        maxDaysSinceCreation: 2,
        maxPdfCount: 0,
        limit: 100,
      });

      for (const user of eligibleUsers) {
        const variant = this.selectAbVariant(user.userId);

        await this.firestoreService.createEmailQueue({
          userId: user.userId,
          userEmail: user.userEmail,
          emailType: 'tutorial',
          abVariant: variant,
          language: user.language as EmailLanguage,
          scheduledFor: new Date(),
          metadata: { displayName: user.displayName },
        });

        scheduled++;
      }

      this.logger.log(`Tutorial emails scheduled: ${scheduled}, skipped: ${skipped}`);
    } catch (error) {
      this.logger.error(`Error scheduling tutorial emails: ${error.message}`);
    }

    return { scheduled, skipped, executedAt: new Date() };
  }

  /**
   * Schedule help emails for users who haven't converted after 3 days
   * Called by cron job every hour
   */
  async scheduleHelpEmails(): Promise<ScheduleEmailsResult> {
    if (!this.isEnabled) {
      return { scheduled: 0, skipped: 0, executedAt: new Date() };
    }

    let scheduled = 0;
    let skipped = 0;

    try {
      // Get users created 3 days ago with 0 PDFs
      const eligibleUsers = await this.firestoreService.getUsersEligibleForEmail({
        emailType: 'help',
        minDaysSinceCreation: 3,
        maxDaysSinceCreation: 4,
        maxPdfCount: 0,
        limit: 100,
      });

      for (const user of eligibleUsers) {
        const variant = this.selectAbVariant(user.userId);

        await this.firestoreService.createEmailQueue({
          userId: user.userId,
          userEmail: user.userEmail,
          emailType: 'help',
          abVariant: variant,
          language: user.language as EmailLanguage,
          scheduledFor: new Date(),
          metadata: { displayName: user.displayName },
        });

        scheduled++;
      }

      this.logger.log(`Help emails scheduled: ${scheduled}, skipped: ${skipped}`);
    } catch (error) {
      this.logger.error(`Error scheduling help emails: ${error.message}`);
    }

    return { scheduled, skipped, executedAt: new Date() };
  }

  /**
   * Schedule day 7 emails (success_story or miss_you based on activity)
   * Called by cron job every hour
   */
  async scheduleDay7Emails(): Promise<ScheduleEmailsResult> {
    if (!this.isEnabled) {
      return { scheduled: 0, skipped: 0, executedAt: new Date() };
    }

    let scheduled = 0;
    let skipped = 0;

    try {
      // Get users created 7 days ago with ≥1 PDF (success_story)
      const activeUsers = await this.firestoreService.getUsersEligibleForEmail({
        emailType: 'success_story',
        minDaysSinceCreation: 7,
        maxDaysSinceCreation: 8,
        minPdfCount: 1,
        limit: 100,
      });

      for (const user of activeUsers) {
        const variant = this.selectAbVariant(user.userId);

        await this.firestoreService.createEmailQueue({
          userId: user.userId,
          userEmail: user.userEmail,
          emailType: 'success_story',
          abVariant: variant,
          language: user.language as EmailLanguage,
          scheduledFor: new Date(),
          metadata: { displayName: user.displayName, pdfCount: user.pdfCount },
        });

        scheduled++;
      }

      // Get users created 7 days ago with 0 PDFs (miss_you)
      const inactiveUsers = await this.firestoreService.getUsersEligibleForEmail({
        emailType: 'miss_you',
        minDaysSinceCreation: 7,
        maxDaysSinceCreation: 8,
        maxPdfCount: 0,
        limit: 100,
      });

      for (const user of inactiveUsers) {
        const variant = this.selectAbVariant(user.userId);

        await this.firestoreService.createEmailQueue({
          userId: user.userId,
          userEmail: user.userEmail,
          emailType: 'miss_you',
          abVariant: variant,
          language: user.language as EmailLanguage,
          scheduledFor: new Date(),
          metadata: { displayName: user.displayName },
        });

        scheduled++;
      }

      this.logger.log(`Day 7 emails scheduled: ${scheduled}, skipped: ${skipped}`);
    } catch (error) {
      this.logger.error(`Error scheduling day 7 emails: ${error.message}`);
    }

    return { scheduled, skipped, executedAt: new Date() };
  }

  /**
   * Handle Resend webhook event
   */
  async handleWebhookEvent(event: {
    type: string;
    data: {
      email_id: string;
      to?: string[];
      click?: { link: string };
    };
  }): Promise<void> {
    const { type, data } = event;
    const resendId = data.email_id;

    try {
      // Find email in queue by resend ID
      const email = await this.firestoreService.getEmailByResendId(resendId);
      if (!email) {
        this.logger.warn(`Webhook received for unknown email: ${resendId}`);
        return;
      }

      // Map Resend event type to our event type
      const eventTypeMap: Record<string, string> = {
        'email.delivered': 'delivered',
        'email.opened': 'opened',
        'email.clicked': 'clicked',
        'email.bounced': 'bounced',
        'email.complained': 'complained',
      };

      const eventType = eventTypeMap[type];
      if (!eventType) {
        this.logger.debug(`Ignoring webhook event type: ${type}`);
        return;
      }

      // Create event record
      await this.firestoreService.createEmailEvent({
        emailQueueId: email.id,
        userId: email.userId,
        eventType,
        linkUrl: data.click?.link,
        metadata: { resendId, originalType: type },
      });

      this.logger.debug(`Email event recorded: ${eventType} for ${resendId}`);
    } catch (error) {
      this.logger.error(`Error handling webhook event: ${error.message}`);
    }
  }

  /**
   * Get email metrics for admin dashboard
   */
  async getMetrics(): Promise<{
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
    openRate: number;
    clickRate: number;
  }> {
    const raw = await this.firestoreService.getEmailMetrics();

    return {
      ...raw,
      openRate: raw.delivered > 0 ? Math.round((raw.opened / raw.delivered) * 10000) / 100 : 0,
      clickRate: raw.opened > 0 ? Math.round((raw.clicked / raw.opened) * 10000) / 100 : 0,
    };
  }

  /**
   * Get A/B test results for admin dashboard
   */
  async getAbTestResults(emailType?: string) {
    const results = await this.firestoreService.getAbTestResults(emailType);

    return results.map(result => ({
      emailType: result.emailType,
      variants: result.variants.map(v => ({
        ...v,
        openRate: v.delivered > 0 ? Math.round((v.opened / v.delivered) * 10000) / 100 : 0,
        clickRate: v.opened > 0 ? Math.round((v.clicked / v.opened) * 10000) / 100 : 0,
      })),
    }));
  }

  /**
   * Get metrics by email type for admin dashboard
   */
  async getMetricsByType() {
    const results = await this.firestoreService.getEmailMetricsByType();

    return results.map(result => ({
      emailType: result.emailType,
      metrics: {
        sent: result.sent,
        delivered: result.delivered,
        opened: result.opened,
        clicked: result.clicked,
        bounced: 0, // TODO: Add to query
        complained: 0, // TODO: Add to query
        openRate: result.delivered > 0 ? Math.round((result.opened / result.delivered) * 10000) / 100 : 0,
        clickRate: result.opened > 0 ? Math.round((result.clicked / result.opened) * 10000) / 100 : 0,
      },
    }));
  }

  /**
   * Initialize A/B variants in Firestore
   */
  async initializeAbVariants(): Promise<void> {
    await this.firestoreService.initializeAbVariants();
  }

  /**
   * Cancel pending onboarding emails for a user who converted
   */
  async cancelOnboardingEmailsForUser(userId: string): Promise<number> {
    // Cancel tutorial, help, miss_you emails since user is now active
    return this.firestoreService.cancelPendingEmails(userId, ['tutorial', 'help', 'miss_you']);
  }

  /**
   * Get onboarding funnel data for admin dashboard
   */
  async getFunnel(period: 'day' | 'week' | 'month' = 'month'): Promise<{
    registeredUsers: number;
    receivedWelcome: number;
    openedWelcome: number;
    clickedWelcome: number;
    firstPdfGenerated: number;
    activatedIn7Days: number;
  }> {
    return this.firestoreService.getOnboardingFunnel(period);
  }

  // ============== Conversion/Limit Emails ==============

  /**
   * Queue a limit-based conversion email
   * Checks if user has already received this email type in current billing period
   */
  async queueLimitEmail(
    userId: string,
    emailType: 'limit_80_percent' | 'limit_100_percent' | 'conversion_blocked' | 'high_usage',
    metadata: {
      pdfsUsed: number;
      limit: number;
      periodEnd: Date;
      periodStart: Date;
      discountCode?: string;
      projectedDaysToLimit?: number;
      displayName?: string;
      email?: string;
      language?: string;
    },
  ): Promise<string | null> {
    if (!this.isEnabled) {
      this.logger.debug('Email service disabled, skipping limit email');
      return null;
    }

    try {
      // Check if template is enabled in Firestore (controlled via frontend toggle)
      const isTemplateEnabled = await this.firestoreService.isTemplateEnabled(emailType);
      if (!isTemplateEnabled) {
        this.logger.debug(`Template ${emailType} is disabled, skipping`);
        return null;
      }

      // Check if user already received this email type in current period
      const hasEmail = await this.firestoreService.hasUserReceivedEmailInPeriod(
        userId,
        emailType,
        metadata.periodStart,
      );

      if (hasEmail) {
        this.logger.debug(`User ${userId} already received ${emailType} in current period, skipping`);
        return null;
      }

      // Get user info if not provided
      let userEmail = metadata.email;
      let displayName = metadata.displayName;
      let language = metadata.language as EmailLanguage || 'en';

      if (!userEmail) {
        const user = await this.firestoreService.getUserById(userId);
        if (!user) {
          this.logger.warn(`User ${userId} not found, cannot send limit email`);
          return null;
        }
        userEmail = user.email;
        displayName = user.displayName;
        // Detect language from country if available
        language = this.detectLanguageFromCountry(user.country);
      }

      // Select A/B variant
      const variant = this.selectAbVariant(userId);

      // Queue the email
      const emailId = await this.firestoreService.createEmailQueue({
        userId,
        userEmail,
        emailType,
        abVariant: variant,
        language,
        scheduledFor: new Date(), // Send immediately
        metadata: {
          displayName,
          pdfsUsed: metadata.pdfsUsed,
          limit: metadata.limit,
          periodEnd: metadata.periodEnd,
          discountCode: metadata.discountCode,
          projectedDaysToLimit: metadata.projectedDaysToLimit,
        },
      });

      this.logger.log(`Limit email ${emailType} queued for user ${userId} (variant ${variant})`);
      return emailId;
    } catch (error) {
      this.logger.error(`Failed to queue limit email ${emailType} for ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Schedule high usage emails for users who are generating many PDFs daily
   * Called by cron job daily
   *
   * Respects the 'enabled' field of the template in email_templates collection
   */
  async scheduleHighUsageEmails(): Promise<ScheduleEmailsResult> {
    if (!this.isEnabled) {
      return { scheduled: 0, skipped: 0, executedAt: new Date() };
    }

    let scheduled = 0;
    let skipped = 0;

    try {
      // Check if template is enabled
      const isTemplateEnabled = await this.firestoreService.isTemplateEnabled('high_usage');
      if (!isTemplateEnabled) {
        this.logger.debug('Template high_usage is disabled, skipping');
        return { scheduled: 0, skipped: 0, executedAt: new Date() };
      }

      // Get users with high usage patterns (>3 PDFs/day for 2 consecutive days)
      const highUsageUsers = await this.firestoreService.getUsersWithHighUsage({
        minPdfsPerDay: 3,
        consecutiveDays: 2,
        limit: 100,
      });

      for (const user of highUsageUsers) {
        const variant = this.selectAbVariant(user.userId);

        await this.firestoreService.createEmailQueue({
          userId: user.userId,
          userEmail: user.userEmail,
          emailType: 'high_usage',
          abVariant: variant,
          language: user.language as EmailLanguage,
          scheduledFor: new Date(),
          metadata: {
            displayName: user.displayName,
            pdfsUsed: user.pdfsUsed,
            limit: user.limit,
            avgPdfsPerDay: user.avgPdfsPerDay,
            projectedDaysToLimit: user.projectedDaysToLimit,
            periodEnd: user.periodEnd,
          },
        });

        scheduled++;
      }

      this.logger.log(`High usage emails scheduled: ${scheduled}, skipped: ${skipped}`);
    } catch (error) {
      this.logger.error(`Error scheduling high usage emails: ${error.message}`);
    }

    return { scheduled, skipped, executedAt: new Date() };
  }

  /**
   * Trigger blocked email immediately when user tries to convert but is blocked
   * Called from frontend via API endpoint
   */
  async triggerBlockedEmail(userId: string): Promise<string | null> {
    if (!this.isEnabled) {
      return null;
    }

    try {
      const user = await this.firestoreService.getUserById(userId);
      if (!user) {
        this.logger.warn(`User ${userId} not found, cannot send blocked email`);
        return null;
      }

      // Only send if user is actually at/over limit
      if (user.plan !== 'free') {
        this.logger.debug(`User ${userId} is not on free plan, skipping blocked email`);
        return null;
      }

      // Get usage data for pdfCount and period dates
      const usage = await this.firestoreService.getOrCreateUsage(userId);
      const limit = user.planLimits?.maxPdfsPerMonth || 25;
      const pdfsUsed = usage.pdfCount || 0;

      if (pdfsUsed < limit) {
        this.logger.debug(`User ${userId} has not reached limit (${pdfsUsed}/${limit}), skipping blocked email`);
        return null;
      }

      return this.queueLimitEmail(userId, 'conversion_blocked', {
        pdfsUsed,
        limit,
        periodStart: usage.periodStart,
        periodEnd: usage.periodEnd,
        discountCode: 'UPGRADE20',
        displayName: user.displayName,
        email: user.email,
        language: this.detectLanguageFromCountry(user.country),
      });
    } catch (error) {
      this.logger.error(`Failed to trigger blocked email for ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Detect email language from user country
   */
  private detectLanguageFromCountry(country?: string): EmailLanguage {
    if (!country) return 'en';

    const spanishCountries = ['MX', 'ES', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'BO', 'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY'];
    const chineseCountries = ['CN', 'TW', 'HK', 'SG'];
    const portugueseCountries = ['BR', 'PT', 'AO', 'MZ', 'CV', 'GW', 'ST', 'TL'];

    if (spanishCountries.includes(country.toUpperCase())) return 'es';
    if (chineseCountries.includes(country.toUpperCase())) return 'zh';
    if (portugueseCountries.includes(country.toUpperCase())) return 'pt';

    return 'en';
  }

  // ============== PRO Retention Methods ==============

  /**
   * Schedule retention emails for inactive PRO users
   * Called by cron job daily
   *
   * Respects the 'enabled' field of each template in email_templates collection
   */
  async scheduleRetentionEmails(): Promise<ScheduleEmailsResult> {
    if (!this.isEnabled) {
      this.logger.debug('Email service disabled');
      return { scheduled: 0, skipped: 0, executedAt: new Date() };
    }

    let scheduled = 0;
    let skipped = 0;

    try {
      // Check which templates are enabled
      const [is7DaysEnabled, is14DaysEnabled, is30DaysEnabled] = await Promise.all([
        this.firestoreService.isTemplateEnabled('pro_inactive_7_days'),
        this.firestoreService.isTemplateEnabled('pro_inactive_14_days'),
        this.firestoreService.isTemplateEnabled('pro_inactive_30_days'),
      ]);

      // Get PRO users inactive 7-13 days (if template enabled)
      if (is7DaysEnabled) {
        const inactive7Days = await this.firestoreService.getProInactiveUsers({
          minDaysInactive: 7,
          maxDaysInactive: 14,
          limit: 50,
        });

        for (const user of inactive7Days) {
          if (user.emailsSent.includes('pro_inactive_7_days')) {
            skipped++;
            continue;
          }

          await this.firestoreService.createEmailQueue({
            userId: user.userId,
            userEmail: user.userEmail,
            emailType: 'pro_inactive_7_days',
            abVariant: this.selectAbVariant(user.userId),
            language: user.language as EmailLanguage,
            scheduledFor: new Date(),
            metadata: {
              displayName: user.displayName,
              daysInactive: user.daysInactive,
              lastActivityAt: user.lastActivityAt,
              pdfsThisMonth: user.pdfsThisMonth,
              labelsThisMonth: user.labelsThisMonth,
            },
          });
          scheduled++;
        }
      } else {
        this.logger.debug('Template pro_inactive_7_days is disabled, skipping');
      }

      // Get PRO users inactive 14-29 days (if template enabled)
      if (is14DaysEnabled) {
        const inactive14Days = await this.firestoreService.getProInactiveUsers({
          minDaysInactive: 14,
          maxDaysInactive: 30,
          limit: 50,
        });

        for (const user of inactive14Days) {
          if (user.emailsSent.includes('pro_inactive_14_days')) {
            skipped++;
            continue;
          }

          await this.firestoreService.createEmailQueue({
            userId: user.userId,
            userEmail: user.userEmail,
            emailType: 'pro_inactive_14_days',
            abVariant: this.selectAbVariant(user.userId),
            language: user.language as EmailLanguage,
            scheduledFor: new Date(),
            metadata: {
              displayName: user.displayName,
              daysInactive: user.daysInactive,
              lastActivityAt: user.lastActivityAt,
              pdfsThisMonth: user.pdfsThisMonth,
              labelsThisMonth: user.labelsThisMonth,
            },
          });
          scheduled++;
        }
      } else {
        this.logger.debug('Template pro_inactive_14_days is disabled, skipping');
      }

      // Get PRO users inactive 30+ days (if template enabled)
      if (is30DaysEnabled) {
        const inactive30Days = await this.firestoreService.getProInactiveUsers({
          minDaysInactive: 30,
          limit: 50,
        });

        for (const user of inactive30Days) {
          if (user.emailsSent.includes('pro_inactive_30_days')) {
            skipped++;
            continue;
          }

          await this.firestoreService.createEmailQueue({
            userId: user.userId,
            userEmail: user.userEmail,
            emailType: 'pro_inactive_30_days',
            abVariant: this.selectAbVariant(user.userId),
            language: user.language as EmailLanguage,
            scheduledFor: new Date(),
            metadata: {
              displayName: user.displayName,
              daysInactive: user.daysInactive,
              lastActivityAt: user.lastActivityAt,
              pdfsThisMonth: user.pdfsThisMonth,
              labelsThisMonth: user.labelsThisMonth,
            },
          });
          scheduled++;
        }
      } else {
        this.logger.debug('Template pro_inactive_30_days is disabled, skipping');
      }

      this.logger.log(`Retention emails scheduled: ${scheduled}, skipped: ${skipped}`);
    } catch (error) {
      this.logger.error(`Error scheduling retention emails: ${error.message}`);
    }

    return { scheduled, skipped, executedAt: new Date() };
  }

  /**
   * Schedule power user recognition emails
   * Called by cron job monthly (first day of month)
   *
   * Respects the 'enabled' field of the template in email_templates collection
   */
  async schedulePowerUserEmails(): Promise<ScheduleEmailsResult> {
    if (!this.isEnabled) {
      this.logger.debug('Email service disabled');
      return { scheduled: 0, skipped: 0, executedAt: new Date() };
    }

    let scheduled = 0;
    const skipped = 0;

    try {
      // Check if template is enabled
      const isTemplateEnabled = await this.firestoreService.isTemplateEnabled('pro_power_user');
      if (!isTemplateEnabled) {
        this.logger.debug('Template pro_power_user is disabled, skipping');
        return { scheduled: 0, skipped: 0, executedAt: new Date() };
      }

      // Get power users from previous month
      const powerUsers = await this.firestoreService.getProPowerUsers({
        minPdfsPerMonth: 50,
        limit: 50,
      });

      for (const user of powerUsers) {
        await this.firestoreService.createEmailQueue({
          userId: user.userId,
          userEmail: user.userEmail,
          emailType: 'pro_power_user',
          abVariant: this.selectAbVariant(user.userId),
          language: user.language as EmailLanguage,
          scheduledFor: new Date(),
          metadata: {
            displayName: user.displayName,
            pdfsThisMonth: user.pdfsThisMonth,
            labelsThisMonth: user.labelsThisMonth,
            monthsAsPro: user.monthsAsPro,
          },
        });
        scheduled++;
      }

      this.logger.log(`Power user emails scheduled: ${scheduled}`);
    } catch (error) {
      this.logger.error(`Error scheduling power user emails: ${error.message}`);
    }

    return { scheduled, skipped, executedAt: new Date() };
  }

  /**
   * Schedule reactivation emails for inactive FREE users
   * Segments:
   * - free_never_used_7d: 0 PDFs, 7-13 days since registration
   * - free_never_used_14d: 0 PDFs, 14+ days since registration
   * - free_tried_abandoned: 1-3 PDFs, 14+ days inactive
   * - free_dormant_30d: >3 PDFs, 30+ days inactive
   * - free_abandoned_60d: Any user, 60+ days inactive
   *
   * Respects the 'enabled' field of each template in email_templates collection
   */
  async scheduleFreeReactivationEmails(): Promise<FreeReactivationResult> {
    if (!this.isEnabled) {
      this.logger.debug('Email service disabled');
      return {
        processed: 0,
        emailsScheduled: 0,
        byType: {
          free_never_used_7d: 0,
          free_never_used_14d: 0,
          free_tried_abandoned: 0,
          free_dormant_30d: 0,
          free_abandoned_60d: 0,
        },
        executedAt: new Date(),
      };
    }

    let processed = 0;
    let emailsScheduled = 0;
    const byType = {
      free_never_used_7d: 0,
      free_never_used_14d: 0,
      free_tried_abandoned: 0,
      free_dormant_30d: 0,
      free_abandoned_60d: 0,
    };

    try {
      // Check which templates are enabled
      const [is7dEnabled, is14dEnabled, isTriedEnabled, isDormantEnabled, isAbandonedEnabled] = await Promise.all([
        this.firestoreService.isTemplateEnabled('free_never_used_7d'),
        this.firestoreService.isTemplateEnabled('free_never_used_14d'),
        this.firestoreService.isTemplateEnabled('free_tried_abandoned'),
        this.firestoreService.isTemplateEnabled('free_dormant_30d'),
        this.firestoreService.isTemplateEnabled('free_abandoned_60d'),
      ]);

      const enabledTemplates = {
        free_never_used_7d: is7dEnabled,
        free_never_used_14d: is14dEnabled,
        free_tried_abandoned: isTriedEnabled,
        free_dormant_30d: isDormantEnabled,
        free_abandoned_60d: isAbandonedEnabled,
      };

      // If all templates are disabled, skip processing
      if (!Object.values(enabledTemplates).some(Boolean)) {
        this.logger.debug('All FREE reactivation templates are disabled, skipping');
        return {
          processed: 0,
          emailsScheduled: 0,
          byType,
          executedAt: new Date(),
        };
      }

      // Get all FREE inactive users
      const inactiveUsers = await this.firestoreService.getFreeInactiveUsers({
        limit: 200,
      });

      for (const user of inactiveUsers) {
        processed++;

        // Determine which email to send based on segment and days
        let emailType: ReactivationEmailType | null = null;

        if (user.segment === 'never_used') {
          // Never used: 7d or 14d based on registration age
          if (user.daysSinceRegistration >= 14 && !user.emailsSent.includes('free_never_used_14d') && enabledTemplates.free_never_used_14d) {
            emailType = 'free_never_used_14d';
          } else if (user.daysSinceRegistration >= 7 && !user.emailsSent.includes('free_never_used_7d') && enabledTemplates.free_never_used_7d) {
            emailType = 'free_never_used_7d';
          }
        } else if (user.segment === 'tried_abandoned') {
          // Tried but abandoned: 1-3 PDFs, 14+ days inactive
          if (!user.emailsSent.includes('free_tried_abandoned') && enabledTemplates.free_tried_abandoned) {
            emailType = 'free_tried_abandoned';
          }
        } else if (user.segment === 'dormant') {
          // Dormant: >3 PDFs, 30+ days inactive
          if (!user.emailsSent.includes('free_dormant_30d') && enabledTemplates.free_dormant_30d) {
            emailType = 'free_dormant_30d';
          }
        } else if (user.segment === 'abandoned') {
          // Abandoned: 60+ days inactive
          if (!user.emailsSent.includes('free_abandoned_60d') && enabledTemplates.free_abandoned_60d) {
            emailType = 'free_abandoned_60d';
          }
        }

        if (!emailType) continue;

        // Schedule the email
        await this.firestoreService.createEmailQueue({
          userId: user.userId,
          userEmail: user.userEmail,
          emailType,
          abVariant: this.selectAbVariant(user.userId),
          language: user.language as EmailLanguage,
          scheduledFor: new Date(),
          metadata: {
            displayName: user.displayName,
            daysSinceRegistration: user.daysSinceRegistration,
            daysInactive: user.daysInactive,
            pdfCount: user.pdfCount,
            labelCount: user.labelCount,
            segment: user.segment,
          },
        });

        byType[emailType]++;
        emailsScheduled++;
      }

      this.logger.log(
        `FREE reactivation emails scheduled: ${emailsScheduled} (never_used_7d: ${byType.free_never_used_7d}, never_used_14d: ${byType.free_never_used_14d}, tried_abandoned: ${byType.free_tried_abandoned}, dormant_30d: ${byType.free_dormant_30d}, abandoned_60d: ${byType.free_abandoned_60d})`,
      );
    } catch (error) {
      this.logger.error(`Error scheduling FREE reactivation emails: ${error.message}`);
    }

    return {
      processed,
      emailsScheduled,
      byType,
      executedAt: new Date(),
    };
  }
}
