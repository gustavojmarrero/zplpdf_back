# Database Schema Reference (Firestore)

Firestore is a schemaless NoSQL database. This document describes the document structures used by the application.

## Collections Overview

| Collection | Purpose | Key Fields |
|------------|---------|------------|
| `users` | User profiles & subscription data | id, email, plan, role |
| `usage` | Monthly usage tracking | userId, pdfCount, labelCount, periodStart/End |
| `conversion_history` | Conversion records | userId, jobId, status, labelCount |
| `zpl-conversions` | Active job status | status, progress, resultUrl |
| `zpl-batches` | Batch job tracking | userId, status, jobs[] |
| `daily_stats` | Aggregated daily metrics | date, totalConversions, byPlan |
| `error_logs` | Error tracking | type, code, severity, status |
| `admin_audit_log` | Admin action logs | adminEmail, action, endpoint |
| `exchange_rates` | Currency rates | date, usdToMxn |
| `stripe_transactions` | Payment records | type, amount, currency |
| `expenses` | Business expenses | category, amount, recurring |
| `monthly_goals` | Revenue goals | month, targets, actuals |
| `subscription_events` | Subscription changes | userId, event, planFrom, planTo |
| `enterprise_contacts` | Contact form submissions | email, company, message |
| `email_queue` | Pending emails | userId, templateId, scheduledFor |
| `email_templates` | Email templates | id, subject, htmlTemplate |
| `zpl_debug_files` | Debug ZPL files | userId, jobId, storagePath |

---

## Core Collections

### `users`

User profile and subscription information.

```typescript
// Interface: src/common/interfaces/user.interface.ts
interface User {
  id: string;               // Firebase UID (document ID)
  email: string;
  displayName?: string;
  emailVerified: boolean;
  plan: 'free' | 'pro' | 'promax' | 'enterprise';
  role: 'user' | 'admin';

  // Stripe subscription
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionPeriodStart?: Date;
  subscriptionPeriodEnd?: Date;

  // Custom limits (enterprise only)
  planLimits?: {
    maxLabelsPerPdf: number;
    maxPdfsPerMonth: number;
    canDownloadImages: boolean;
  };

  // Admin plan simulation
  simulatedPlan?: 'free' | 'pro' | 'promax' | 'enterprise';
  simulationExpiresAt?: Date;

  // Geolocation
  country?: string;         // ISO 3166-1 alpha-2 (MX, US, etc.)
  city?: string;
  countrySource?: 'ip' | 'stripe' | 'manual';
  countryDetectedAt?: Date;

  // Activity tracking
  lastActivityAt?: Date;
  notifiedInactive7Days?: boolean;
  notifiedInactive30Days?: boolean;

  createdAt: Date;
  updatedAt: Date;
}
```

**Queries:**
- By ID: `firestore.collection('users').doc(userId).get()`
- By email: `firestore.collection('users').where('email', '==', email).get()`
- Admins: `firestore.collection('users').where('role', '==', 'admin').get()`

### `usage`

Monthly usage counters per user. Document ID format: `{userId}_{periodId}`.

```typescript
// Interface: src/common/interfaces/usage.interface.ts
interface Usage {
  userId: string;
  pdfCount: number;         // PDFs created this period
  labelCount: number;       // Total labels processed
  periodStart: Date;        // Billing period start
  periodEnd: Date;          // Billing period end
  periodId: string;         // e.g., "2025-01" or "sub_2025-01-15"
  createdAt: Date;
  updatedAt: Date;
}
```

**Queries:**
- Current period: `firestore.collection('usage').doc(\`${userId}_${periodId}\`).get()`
- User's all periods: `firestore.collection('usage').where('userId', '==', userId).get()`

### `conversion_history`

Record of each conversion (successful or failed).

```typescript
// Interface: src/common/interfaces/conversion-history.interface.ts
interface ConversionHistory {
  userId: string;
  jobId: string;
  labelCount: number;
  labelSize: string;        // "4x6", "2x1", etc.
  status: 'completed' | 'failed';
  outputFormat: 'pdf' | 'png' | 'jpeg';
  fileUrl?: string | null;  // Signed URL for completed
  createdAt: Date;
}
```

**Queries:**
- User history: `firestore.collection('conversion_history').where('userId', '==', userId).orderBy('createdAt', 'desc').limit(50)`

### `zpl-conversions`

Active conversion job status. Document ID is the jobId.

```typescript
// Interface: src/modules/cache/firestore.service.ts:169
interface ConversionStatus {
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: number;         // 0-100
  userId?: string;
  resultUrl?: string;
  filename?: string;
  zplContent?: string;
  labelSize?: string;
  outputFormat?: string;
  zplHash?: string;
  createdAt: string;        // ISO string
  updatedAt: string;
  errorMessage?: string;

  // Granular progress
  phase?: 'validating' | 'processing' | 'merging' | 'uploading';
  chunksCompleted?: number;
  chunksTotal?: number;
}
```

### `daily_stats`

Aggregated metrics per day. Document ID format: `YYYY-MM-DD`.

```typescript
// Interface: src/modules/cache/firestore.service.ts:32
interface DailyStats {
  date: string;             // "2025-01-15"
  totalConversions: number;
  totalLabels: number;
  totalPdfs: number;
  activeUserIds: string[];  // Unique users that day
  errorCount: number;
  successCount: number;
  failureCount: number;
  conversionsByPlan: {
    free: { pdfs: number; labels: number };
    pro: { pdfs: number; labels: number };
    enterprise: { pdfs: number; labels: number };
  };
}
```

### `error_logs`

Application error tracking.

```typescript
// Interface: src/modules/cache/firestore.service.ts:59
interface ErrorLog {
  id: string;               // Auto-generated Firestore ID
  errorId: string;          // ERR-YYYYMMDD-XXXXX
  type: string;             // Error category
  code: string;             // Error code
  message: string;
  severity: 'error' | 'warning' | 'critical';
  status: 'open' | 'investigating' | 'resolved' | 'dismissed';
  source: 'frontend' | 'backend' | 'system';

  userId?: string;
  userEmail?: string;
  jobId?: string;
  context?: Record<string, any>;
  notes?: string;
  resolvedAt?: Date;
  userAgent?: string;
  url?: string;
  stackTrace?: string;

  createdAt: Date;
  updatedAt?: Date;
}
```

---

## Finance Collections

### `stripe_transactions`

Record of all Stripe payments.

```typescript
interface StripeTransaction {
  stripeId: string;         // Stripe payment/invoice ID
  type: 'payment' | 'refund' | 'subscription';
  userId: string;
  userEmail: string;
  amount: number;           // In smallest currency unit (cents)
  currency: 'usd' | 'mxn';
  plan: string;
  status: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}
```

### `expenses`

Business expenses tracking.

```typescript
interface Expense {
  id: string;
  category: string;         // 'hosting', 'api', 'marketing', etc.
  description: string;
  amount: number;
  currency: 'usd' | 'mxn';
  date: Date;
  recurring: boolean;
  recurringFrequency?: 'monthly' | 'yearly';
  vendor?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### `monthly_goals`

Revenue and conversion goals.

```typescript
interface MonthlyGoal {
  month: string;            // "2025-01"
  revenueTarget: number;
  conversionsTarget: number;
  newUsersTarget: number;
  proSubscribersTarget: number;

  // Actuals (updated daily)
  revenueActual: number;
  conversionsActual: number;
  newUsersActual: number;
  proSubscribersActual: number;

  createdAt: Date;
  updatedAt: Date;
}
```

### `exchange_rates`

Currency exchange rates (USD/MXN).

```typescript
interface ExchangeRate {
  date: string;             // "2025-01-15"
  usdToMxn: number;         // e.g., 17.5
  source: string;           // API source
  createdAt: Date;
}
```

---

## Plan Limits Reference

Default limits defined in `src/common/interfaces/user.interface.ts:40`:

| Plan | Labels/PDF | PDFs/Month | Image Export |
|------|------------|------------|--------------|
| free | 100 | 25 | No |
| pro | 500 | 500 | Yes |
| promax | 1000 | 1000 | Yes |
| enterprise | Unlimited | Unlimited | Yes |

---

## Firestore Indexes

Required composite indexes (create via Firebase Console or CLI):

```bash
# Users by plan and creation date
gcloud firestore indexes composite create \
  --project=intranet-guatever \
  --collection-group=users \
  --field-config=field-path=plan,order=ascending \
  --field-config=field-path=createdAt,order=descending

# Error logs by status and date
gcloud firestore indexes composite create \
  --project=intranet-guatever \
  --collection-group=error_logs \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=createdAt,order=descending

# Conversion history by user and date
gcloud firestore indexes composite create \
  --project=intranet-guatever \
  --collection-group=conversion_history \
  --field-config=field-path=userId,order=ascending \
  --field-config=field-path=createdAt,order=descending
```
