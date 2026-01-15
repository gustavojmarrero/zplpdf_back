# ZPLPDF - Agent Navigation Guide

> Last updated: 2026-01-15
> Framework: NestJS 10.x
> Database: Google Cloud Firestore
> Runtime: Node.js (ESM modules)

## Quick Answers

### "Where do I find database queries?"
→ `src/modules/cache/firestore.service.ts`
→ Pattern: `this.firestore.collection('name').doc(id).get()`

### "Where do I add a new API endpoint?"
→ `src/modules/[domain]/[domain].controller.ts`
→ Pattern: `@Get()/@Post()/@Put()/@Delete()/@Patch()` decorators

### "Where is the business logic for X?"
→ `src/modules/[domain]/[domain].service.ts`
→ Inject dependencies via constructor

### "Where are the database models/interfaces?"
→ `src/common/interfaces/` - TypeScript interfaces
→ No ORM schema - Firestore is schemaless

### "How do I add authentication to an endpoint?"
→ Add `@UseGuards(FirebaseAuthGuard)` decorator
→ Access user with `@CurrentUser() user: FirebaseUser`
→ Guard located: `src/common/guards/firebase-auth.guard.ts`

### "How do I add admin-only access?"
→ Add `@UseGuards(AdminAuthGuard)` decorator
→ Access admin with `@AdminUser() admin: AdminUserData`
→ Guard located: `src/common/guards/admin-auth.guard.ts`

### "Where is the ZPL conversion logic?"
→ `src/modules/zpl/zpl.service.ts` - Main conversion service
→ Uses Labelary API for ZPL → image conversion
→ Rate limited with Bottleneck (1 req/sec)

### "Where are Stripe webhooks handled?"
→ `src/modules/webhooks/webhooks.controller.ts`
→ `src/modules/webhooks/webhooks.service.ts`

### "Where are scheduled/cron jobs?"
→ `src/modules/cron/cron.controller.ts` - HTTP endpoints for Cloud Scheduler
→ Protected with `CronAuthGuard` (X-Cron-Secret header)

## Directory Map

```
src/
├── main.ts                     # Bootstrap: Swagger, CORS, Helmet security
├── app.module.ts               # Root module with ThrottlerModule (100 req/min)
├── app.controller.ts           # Health check endpoint (GET /)
├── app.service.ts              # App service
├── config/                     # Configuration utilities
├── utils/                      # Timezone utilities, helpers
│   └── timezone.util.ts        # GMT-6 (Mérida) date handling
├── common/                     # Shared code across modules
│   ├── guards/                 # Auth guards
│   │   ├── firebase-auth.guard.ts    # User authentication
│   │   ├── admin-auth.guard.ts       # Admin-only access
│   │   └── cron-auth.guard.ts        # Cron job authentication
│   ├── decorators/             # Custom decorators
│   │   ├── current-user.decorator.ts # @CurrentUser()
│   │   └── admin-user.decorator.ts   # @AdminUser()
│   ├── filters/                # Exception filters
│   ├── interceptors/           # Request interceptors
│   ├── interfaces/             # TypeScript interfaces
│   │   ├── user.interface.ts         # User, PlanType, PlanLimits
│   │   ├── usage.interface.ts        # Usage tracking
│   │   ├── conversion-history.interface.ts
│   │   └── finance.interface.ts      # Stripe, expenses, goals
│   ├── constants/              # Error codes, blocked domains
│   ├── utils/                  # Error ID generator
│   └── services/               # Shared services
│       └── period-calculator.service.ts  # Billing period logic
├── modules/
│   ├── zpl/                    # Core ZPL conversion (main feature)
│   │   ├── zpl.controller.ts   # /zpl/* endpoints
│   │   ├── zpl.service.ts      # Conversion logic + Labelary API
│   │   ├── dto/                # Request/Response DTOs
│   │   ├── enums/              # LabelSize, OutputFormat
│   │   ├── interfaces/         # Batch, analytics interfaces
│   │   ├── validation/         # ZPL syntax validator
│   │   ├── logging/            # Validation metrics
│   │   └── services/           # Labelary queue, analytics
│   ├── auth/                   # Firebase Admin SDK
│   │   └── firebase-admin.service.ts
│   ├── users/                  # User management
│   │   ├── users.controller.ts # /users/* endpoints
│   │   ├── users.service.ts    # User sync, limits, history
│   │   └── dto/                # Profile, limits DTOs
│   ├── payments/               # Stripe subscriptions
│   │   ├── payments.controller.ts
│   │   └── payments.service.ts
│   ├── billing/                # Invoice & payment methods
│   │   ├── billing.controller.ts
│   │   └── billing.service.ts
│   ├── webhooks/               # Stripe webhook handlers
│   │   ├── webhooks.controller.ts
│   │   └── webhooks.service.ts
│   ├── admin/                  # Admin dashboard API
│   │   ├── admin.controller.ts # /admin/* endpoints
│   │   ├── admin.service.ts
│   │   ├── dto/                # Admin DTOs
│   │   └── services/           # Finance, geo, goals, expenses
│   ├── cache/                  # Firestore data layer
│   │   └── firestore.service.ts  # ALL database operations
│   ├── storage/                # Cloud Storage
│   │   └── storage.service.ts  # File uploads, signed URLs
│   ├── email/                  # Email system (Resend)
│   │   ├── email.controller.ts
│   │   ├── email-templates.controller.ts
│   │   ├── email.service.ts
│   │   └── templates/          # Email HTML templates
│   ├── cron/                   # Scheduled jobs
│   │   ├── cron.controller.ts  # Cloud Scheduler endpoints
│   │   └── cron.service.ts
│   ├── errors/                 # Error logging
│   │   ├── errors.controller.ts
│   │   └── errors.service.ts
│   ├── contact/                # Contact form
│   ├── queue/                  # Cloud Tasks
│   ├── analytics/              # GA4 integration
│   └── health/                 # Health checks
└── scripts/                    # Utility scripts
```

## File Naming Conventions

| Need to...                | Look for file named...           |
|---------------------------|----------------------------------|
| Add endpoint              | `*.controller.ts`                |
| Add business logic        | `*.service.ts`                   |
| Modify DB query           | `src/modules/cache/firestore.service.ts` |
| Add validation            | `dto/*.dto.ts`                   |
| Add auth guard            | `src/common/guards/*.guard.ts`   |
| Add decorator             | `src/common/decorators/*.ts`     |
| Add TypeScript interface  | `src/common/interfaces/*.ts`     |
| Add error code            | `src/common/constants/error-codes.ts` |

## Import Path Convention

**IMPORTANT:** This project uses ESM modules. All imports MUST include `.js` extension:

```typescript
// Correct
import { FirestoreService } from '../cache/firestore.service.js';

// Incorrect - will fail at runtime
import { FirestoreService } from '../cache/firestore.service';
```

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (use 8080 for Cloud Run) |
| `FIREBASE_CREDENTIALS` | Firebase Admin SDK JSON |
| `GCP_STORAGE_BUCKET` | Cloud Storage bucket name |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `ADMIN_EMAILS` | Comma-separated admin emails |
| `CRON_SECRET_KEY` | Cron job authentication |

## Related Repositories

- **Backend (this repo):** `/Users/gustavomarrero/Documents/node/zplpdf`
- **Frontend (Next.js):** `/Users/gustavomarrero/Documents/Next/zplpdf`
