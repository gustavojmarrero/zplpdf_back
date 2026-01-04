/**
 * Migration script to move ALL email templates to Firestore with A/B variant support
 *
 * This script:
 * 1. Imports existing hardcoded templates from email-templates.ts
 * 2. Converts them to Firestore structure with A/B variants
 * 3. Creates/updates all 20 email templates in Firestore
 *
 * Run with: GOOGLE_APPLICATION_CREDENTIALS=./firebase-credentials.json npx tsx src/scripts/migrate-all-templates-ab.ts
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { getEmailTemplate } from '../modules/email/templates/email-templates.js';
import type { EmailType, AbVariant, EmailLanguage, TemplateType } from '../modules/email/interfaces/email.interface.js';

// Initialize Firebase
const serviceAccount = JSON.parse(
  readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS || './firebase-credentials.json', 'utf-8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Template metadata for all 20 email types
const TEMPLATE_METADATA: Record<EmailType, {
  templateType: TemplateType;
  name: string;
  description: string;
  triggerDays: number;
  variables: string[];
}> = {
  // Onboarding emails
  welcome: {
    templateType: 'onboarding',
    name: 'Welcome Email',
    description: 'Sent immediately after user registration',
    triggerDays: 0,
    variables: ['userName', 'appUrl'],
  },
  tutorial: {
    templateType: 'onboarding',
    name: 'Tutorial Email',
    description: 'Quick tutorial for new users who haven\'t converted yet',
    triggerDays: 1,
    variables: ['userName', 'appUrl'],
  },
  help: {
    templateType: 'onboarding',
    name: 'Help Email',
    description: 'Offer help to users who haven\'t started converting',
    triggerDays: 3,
    variables: ['userName', 'appUrl', 'docsUrl'],
  },
  success_story: {
    templateType: 'onboarding',
    name: 'Success Story Email',
    description: 'Show users how businesses use ZPLPDF',
    triggerDays: 5,
    variables: ['userName', 'pdfCount', 'pricingUrl'],
  },
  miss_you: {
    templateType: 'onboarding',
    name: 'Miss You Email',
    description: 'Re-engagement email for inactive users',
    triggerDays: 7,
    variables: ['userName', 'appUrl'],
  },
  // Conversion emails (limit-based for FREE users)
  limit_80_percent: {
    templateType: 'conversion',
    name: '80% Quota Reached',
    description: 'Alert when FREE user reaches 80% of monthly quota',
    triggerDays: 0,
    variables: ['userName', 'pdfsUsed', 'limit', 'pricingUrl'],
  },
  limit_100_percent: {
    templateType: 'conversion',
    name: '100% Quota Reached',
    description: 'Alert when FREE user reaches 100% of monthly quota',
    triggerDays: 0,
    variables: ['userName', 'pdfsUsed', 'limit', 'discountCode', 'pricingUrl'],
  },
  conversion_blocked: {
    templateType: 'conversion',
    name: 'Conversion Blocked',
    description: 'Sent when user tries to convert but is blocked',
    triggerDays: 0,
    variables: ['userName', 'pdfsUsed', 'limit', 'discountCode', 'pricingUrl'],
  },
  high_usage: {
    templateType: 'conversion',
    name: 'High Usage Alert',
    description: 'Proactive alert for users with high conversion rate',
    triggerDays: 0,
    variables: ['userName', 'avgPdfsPerDay', 'projectedDaysToLimit', 'pricingUrl'],
  },
  // PRO Retention emails
  pro_inactive_7_days: {
    templateType: 'pro_retention',
    name: 'PRO Inactive 7 Days',
    description: 'Check-in email for PRO users inactive for 7 days',
    triggerDays: 7,
    variables: ['userName', 'daysInactive', 'appUrl'],
  },
  pro_inactive_14_days: {
    templateType: 'pro_retention',
    name: 'PRO Inactive 14 Days',
    description: 'Follow-up for PRO users inactive for 14 days',
    triggerDays: 14,
    variables: ['userName', 'daysInactive', 'appUrl', 'feedbackUrl'],
  },
  pro_inactive_30_days: {
    templateType: 'pro_retention',
    name: 'PRO Inactive 30 Days',
    description: 'Final check-in for PRO users inactive for 30 days',
    triggerDays: 30,
    variables: ['userName', 'daysInactive', 'appUrl', 'feedbackUrl'],
  },
  pro_power_user: {
    templateType: 'pro_retention',
    name: 'PRO Power User',
    description: 'Thank you email for highly active PRO users',
    triggerDays: 0,
    variables: ['userName', 'pdfsThisMonth', 'labelsThisMonth', 'monthsAsPro'],
  },
  // FREE Reactivation emails
  free_never_used_7d: {
    templateType: 'free_reactivation',
    name: 'Never Used - 7 Days',
    description: 'First reminder for FREE users who never converted',
    triggerDays: 7,
    variables: ['userName', 'appUrl'],
  },
  free_never_used_14d: {
    templateType: 'free_reactivation',
    name: 'Never Used - 14 Days',
    description: 'Second reminder for FREE users who never converted',
    triggerDays: 14,
    variables: ['userName', 'appUrl'],
  },
  free_tried_abandoned: {
    templateType: 'free_reactivation',
    name: 'Tried & Abandoned',
    description: 'Re-engagement for users who converted once then stopped',
    triggerDays: 14,
    variables: ['userName', 'pdfCount', 'appUrl', 'feedbackUrl'],
  },
  free_dormant_30d: {
    templateType: 'free_reactivation',
    name: 'Dormant 30 Days',
    description: 'Check-in for FREE users inactive for 30 days',
    triggerDays: 30,
    variables: ['userName', 'appUrl', 'feedbackUrl'],
  },
  free_abandoned_60d: {
    templateType: 'free_reactivation',
    name: 'Abandoned 60 Days',
    description: 'Final re-engagement attempt after 60 days',
    triggerDays: 60,
    variables: ['userName', 'appUrl'],
  },
};

// Placeholder data to generate templates
// Using actual values that will be replaced with placeholders after generation
const PLACEHOLDER_DATA = {
  displayName: '{{PLACEHOLDER_USER_NAME}}',
  email: '{{PLACEHOLDER_EMAIL}}',
  pdfCount: 10,
  pdfsUsed: 20,
  limit: 25,
  periodEnd: new Date(),
  discountCode: '{{PLACEHOLDER_DISCOUNT_CODE}}',
  projectedDaysToLimit: 5,
  avgPdfsPerDay: 3,
  daysInactive: 7,
  lastActivityAt: new Date(),
  pdfsThisMonth: 100,
  labelsThisMonth: 500,
  monthsAsPro: 3,
  daysSinceRegistration: 14,
  pdfsAvailable: 25,
  labelCount: 150,
};

// Mapping from placeholder markers to final placeholders
const PLACEHOLDER_REPLACEMENTS: Record<string, string> = {
  '{{PLACEHOLDER_USER_NAME}}': '{userName}',
  '{{PLACEHOLDER_EMAIL}}': '{userEmail}',
  '{{PLACEHOLDER_DISCOUNT_CODE}}': '{discountCode}',
};

const LANGUAGES: EmailLanguage[] = ['en', 'es', 'zh', 'pt'];
const VARIANTS: AbVariant[] = ['A', 'B'];

interface LanguageContent {
  en: { subject: string; body: string };
  es: { subject: string; body: string };
  zh: { subject: string; body: string };
  pt?: { subject: string; body: string };
}

interface TemplateContent {
  A: LanguageContent;
  B: LanguageContent;
}

function replacePlaceholders(text: string): string {
  let result = text;
  for (const [marker, placeholder] of Object.entries(PLACEHOLDER_REPLACEMENTS)) {
    result = result.replace(new RegExp(marker.replace(/[{}]/g, '\\$&'), 'g'), placeholder);
  }
  return result;
}

async function generateTemplateContent(emailType: EmailType): Promise<TemplateContent> {
  const content: TemplateContent = {
    A: { en: { subject: '', body: '' }, es: { subject: '', body: '' }, zh: { subject: '', body: '' } },
    B: { en: { subject: '', body: '' }, es: { subject: '', body: '' }, zh: { subject: '', body: '' } },
  };

  for (const variant of VARIANTS) {
    for (const lang of LANGUAGES) {
      try {
        const emailContent = getEmailTemplate(emailType, variant, lang, PLACEHOLDER_DATA);

        // Replace placeholder markers with actual placeholders
        const subject = replacePlaceholders(emailContent.subject);
        const body = replacePlaceholders(emailContent.html);

        if (lang === 'pt') {
          content[variant].pt = { subject, body };
        } else {
          content[variant][lang] = { subject, body };
        }
      } catch (error) {
        console.error(`Error generating content for ${emailType} ${variant} ${lang}:`, error);
      }
    }
  }

  return content;
}

async function migrateTemplate(emailType: EmailType): Promise<void> {
  const metadata = TEMPLATE_METADATA[emailType];
  const content = await generateTemplateContent(emailType);

  const templateData = {
    templateType: metadata.templateType,
    templateKey: emailType,
    name: metadata.name,
    description: metadata.description,
    triggerDays: metadata.triggerDays,
    enabled: false, // Start disabled, enable via frontend
    content,
    variables: metadata.variables,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: 'migration-script',
    version: 1,
  };

  // Check if template already exists
  const existingQuery = await db
    .collection('email_templates')
    .where('templateKey', '==', emailType)
    .limit(1)
    .get();

  if (!existingQuery.empty) {
    // Update existing template with new A/B structure
    const existingDoc = existingQuery.docs[0];
    const existingData = existingDoc.data();

    // Preserve enabled status if it exists
    templateData.enabled = existingData.enabled ?? false;
    templateData.version = (existingData.version || 0) + 1;
    templateData.createdAt = existingData.createdAt?.toDate?.() || new Date();

    await existingDoc.ref.update({
      ...templateData,
      updatedAt: new Date(),
    });

    console.log(`✅ Updated: ${emailType} (preserved enabled: ${templateData.enabled})`);
  } else {
    // Create new template
    await db.collection('email_templates').add(templateData);
    console.log(`✅ Created: ${emailType}`);
  }
}

async function main() {
  console.log('🚀 Starting migration of all email templates to Firestore with A/B support...\n');

  const emailTypes = Object.keys(TEMPLATE_METADATA) as EmailType[];

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const emailType of emailTypes) {
    try {
      const existingQuery = await db
        .collection('email_templates')
        .where('templateKey', '==', emailType)
        .limit(1)
        .get();

      await migrateTemplate(emailType);

      if (existingQuery.empty) {
        created++;
      } else {
        updated++;
      }
    } catch (error) {
      console.error(`❌ Failed: ${emailType}`, error);
      failed++;
    }
  }

  console.log('\n📊 Migration Summary:');
  console.log(`   Created: ${created}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total: ${emailTypes.length}`);

  console.log('\n✨ Migration complete!');
  console.log('\n⚠️  Note: All new templates are created with enabled: false');
  console.log('    Enable them via the frontend admin panel when ready.');

  process.exit(0);
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
