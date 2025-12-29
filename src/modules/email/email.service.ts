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
      // Get email template
      const template = getEmailTemplate(
        queueItem.emailType as EmailType,
        queueItem.abVariant as AbVariant,
        queueItem.language as EmailLanguage,
        {
          displayName: queueItem.metadata?.displayName || 'there',
          email: queueItem.userEmail,
        },
      );

      // Send via Resend
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: queueItem.userEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
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
}
