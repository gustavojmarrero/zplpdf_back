/**
 * Email Onboarding Module Interfaces
 * Firestore collections: email_queue, email_events, ab_variants
 */

// ============== Email Types ==============

// Onboarding emails
export type OnboardingEmailType = 'welcome' | 'tutorial' | 'help' | 'success_story' | 'miss_you';

// Conversion emails (limit-based for FREE users)
export type ConversionEmailType = 'limit_80_percent' | 'limit_100_percent' | 'conversion_blocked' | 'high_usage';

// Retention emails (for PRO users)
export type RetentionEmailType = 'pro_inactive_7_days' | 'pro_inactive_14_days' | 'pro_inactive_30_days' | 'pro_power_user';

// Reactivation emails (for inactive FREE users)
export type ReactivationEmailType = 'free_never_used_7d' | 'free_never_used_14d' | 'free_tried_abandoned' | 'free_dormant_30d' | 'free_abandoned_60d';

// All email types
export type EmailType = OnboardingEmailType | ConversionEmailType | RetentionEmailType | ReactivationEmailType;

export type EmailStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export type EmailEventType = 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained';

export type AbVariant = 'A' | 'B';

export type EmailLanguage = 'en' | 'es' | 'zh';

// ============== Email Queue ==============

export interface EmailQueue {
  id: string;
  userId: string;
  userEmail: string;
  emailType: EmailType;
  status: EmailStatus;
  resendId?: string;
  abVariant: AbVariant;
  language: EmailLanguage;
  metadata?: Record<string, any>;
  scheduledFor: Date;
  sentAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEmailQueueData {
  userId: string;
  userEmail: string;
  emailType: EmailType;
  abVariant: AbVariant;
  language: EmailLanguage;
  scheduledFor: Date;
  metadata?: Record<string, any>;
}

// ============== Email Events ==============

export interface EmailEvent {
  id: string;
  emailQueueId: string;
  userId: string;
  eventType: EmailEventType;
  linkUrl?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

export interface CreateEmailEventData {
  emailQueueId: string;
  userId: string;
  eventType: EmailEventType;
  linkUrl?: string;
  metadata?: Record<string, any>;
}

// ============== A/B Variants ==============

export interface AbVariantConfig {
  id: string;
  emailType: EmailType;
  variant: AbVariant;
  subjectLine: Record<EmailLanguage, string>;
  isActive: boolean;
  trafficPercentage: number;
  createdAt: Date;
}

// ============== Email Content Templates ==============

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailTemplateData {
  displayName: string;
  email: string;
  language: EmailLanguage;
  variant: AbVariant;
  unsubscribeUrl?: string;
}

// ============== Email Metrics ==============

export interface EmailMetrics {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  openRate: number;
  clickRate: number;
}

export interface AbTestResult {
  emailType: EmailType;
  variants: Array<{
    variant: AbVariant;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    openRate: number;
    clickRate: number;
  }>;
}

export interface EmailMetricsByType {
  emailType: EmailType;
  metrics: EmailMetrics;
}

// ============== Service Results ==============

export interface ProcessQueueResult {
  sent: number;
  failed: number;
  executedAt: Date;
}

export interface ScheduleEmailsResult {
  scheduled: number;
  skipped: number;
  executedAt: Date;
}

// ============== Eligibility Checks ==============

export interface UserEmailEligibility {
  userId: string;
  userEmail: string;
  displayName?: string;
  language: EmailLanguage;
  pdfCount: number;
  daysSinceCreation: number;
  hasReceivedEmail: (emailType: EmailType) => boolean;
}

// ============== Limit Email Metadata ==============

export interface LimitEmailMetadata {
  pdfsUsed: number;
  limit: number;
  periodEnd: Date;
  discountCode?: string;
  projectedDaysToLimit?: number;
}

export interface HighUsageUser {
  userId: string;
  userEmail: string;
  displayName?: string;
  language: EmailLanguage;
  avgPdfsPerDay: number;
  pdfsUsed: number;
  limit: number;
  projectedDaysToLimit: number;
}

// ============== PRO Retention Interfaces ==============

export interface ProInactiveUser {
  userId: string;
  userEmail: string;
  displayName?: string;
  language: EmailLanguage;
  daysInactive: number;
  lastActivityAt: Date | null;
  pdfsThisMonth: number;
  labelsThisMonth: number;
  emailsSent: string[];
}

export interface ProPowerUser {
  userId: string;
  userEmail: string;
  displayName?: string;
  language: EmailLanguage;
  pdfsThisMonth: number;
  labelsThisMonth: number;
  monthsAsPro: number;
}

// ============== FREE Reactivation Interfaces ==============

export type FreeInactiveSegment = 'never_used' | 'tried_abandoned' | 'dormant' | 'abandoned';

export interface FreeInactiveUser {
  userId: string;
  userEmail: string;
  displayName?: string;
  language: EmailLanguage;
  registeredAt: Date;
  lastActiveAt: Date | null;
  daysSinceRegistration: number;
  daysInactive: number;
  pdfCount: number;
  labelCount: number;
  segment: FreeInactiveSegment;
  emailsSent: string[];
  lastEmailSentAt: Date | null;
  lastEmailType: string | null;
}

export interface FreeReactivationResult {
  processed: number;
  emailsScheduled: number;
  byType: {
    free_never_used_7d: number;
    free_never_used_14d: number;
    free_tried_abandoned: number;
    free_dormant_30d: number;
    free_abandoned_60d: number;
  };
  executedAt: Date;
}
