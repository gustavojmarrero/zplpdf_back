# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ZPLPDF is a NestJS backend API for converting ZPL (Zebra Programming Language) files to PDF/PNG/JPEG. It uses Google Cloud Run for deployment with Firestore for data persistence and Cloud Storage for file storage.

## Common Commands

**IMPORTANTE:** El servidor SIEMPRE debe correr en el puerto 8080 (compatibilidad con Cloud Run).

```bash
# Development
PORT=8080 npm run start:dev   # Start dev server on port 8080 (REQUIRED)
npm run start:debug           # Start with debugger attached

# Build & Deploy
npm run build              # Compile TypeScript
npm run deploy:build       # Build Docker image in GCR
npm run deploy:run         # Deploy to Cloud Run

# Testing
npm test                   # Run unit tests
npm run test:watch         # Run tests in watch mode
npm run test:cov           # Run tests with coverage
npm run test:e2e           # Run end-to-end tests

# Code Quality
npm run lint               # ESLint with auto-fix
npm run format             # Prettier formatting
```

**Note:** Cloud Run requires port 8080. Set `PORT=8080` in `.env` for local testing with production parity.

## Architecture

### Module Structure

```
src/
├── main.ts                    # Bootstrap with Swagger, CORS, Helmet security
├── app.module.ts              # Root module with ThrottlerModule (100 req/min)
├── modules/
│   ├── zpl/                   # Core conversion logic
│   ├── auth/                  # Firebase Admin authentication
│   ├── users/                 # User management & subscription limits
│   ├── payments/              # Stripe integration
│   ├── billing/               # Usage tracking & billing periods
│   ├── admin/                 # Admin dashboard metrics
│   ├── webhooks/              # Stripe webhook handlers
│   ├── cache/                 # Firestore service layer
│   ├── cron/                  # Scheduled jobs
│   ├── errors/                # Error tracking system
│   └── contact/               # Contact form
├── common/
│   ├── guards/                # FirebaseAuthGuard, AdminAuthGuard, CronAuthGuard
│   ├── decorators/            # @CurrentUser, @AdminUser
│   ├── filters/               # HttpExceptionFilter
│   ├── interceptors/          # RequestIdInterceptor
│   └── interfaces/            # User, Usage, ConversionHistory types
└── utils/                     # Timezone utilities
```

### Key Services

**ZplService** (`modules/zpl/zpl.service.ts`)
- Converts ZPL to PDF/PNG/JPEG via Labelary API
- Rate-limited with Bottleneck (1 req/sec, max 3 concurrent)
- Chunks labels into batches of 50 (Labelary limit)
- Deduplicates identical labels, respects ^PQ copy counts
- Supports batch processing for Pro/Enterprise plans

**FirestoreService** (`modules/cache/firestore.service.ts`)
- Central data layer for users, conversions, usage, errors
- Collections: `users`, `usage`, `conversions`, `daily_stats`, `global_totals`, `error_logs`
- Aggregated daily stats for dashboard performance

**UsersService** (`modules/users/users.service.ts`)
- Syncs Firebase Auth users with Firestore
- Enforces plan limits (labels per PDF, PDFs per month)
- Tracks billing periods from subscription start date

**PaymentsService** (`modules/payments/payments.service.ts`)
- Stripe Checkout for subscriptions (USD and MXN)
- Customer portal for subscription management
- Test/Live key validation by environment

### Plan System

| Plan       | Labels/PDF | PDFs/Month | Image Export | Batch |
|------------|------------|------------|--------------|-------|
| free       | 100        | 25         | No           | No    |
| pro        | 500        | 500        | Yes          | 10    |
| enterprise | Unlimited  | Unlimited  | Yes          | 50    |

### API Endpoints

All endpoints prefixed with `/api`:
- `POST /zpl/convert` - Start ZPL conversion (requires auth)
- `GET /zpl/status/:jobId` - Check conversion status
- `GET /zpl/download/:jobId` - Get signed download URL
- `POST /zpl/preview` - Generate PNG previews
- `POST /zpl/count-labels` - Count labels in ZPL
- `POST /zpl/batch` - Batch conversion (Pro/Enterprise)
- `GET /docs` - Swagger documentation

### Authentication

Uses Firebase Auth ID tokens. Guards:
- `FirebaseAuthGuard` - Validates JWT, injects user via `@CurrentUser()`
- `AdminAuthGuard` - Checks user email against `ADMIN_EMAILS` env var
- `CronAuthGuard` - Validates `X-Cron-Secret` header for scheduled jobs

### Google Cloud Project

- **Project ID:** `intranet-guatever`
- **Cloud Run Service:** `zplpdf-service`
- **Region:** `us-central1`

### Environment Variables

Key variables (see `.env.example`):
- `PORT` - Server port (default 3000, use **8080** for Cloud Run)
- `GOOGLE_CREDENTIALS` / `FIREBASE_CREDENTIALS` - Service account JSON
- `GCP_STORAGE_BUCKET` - Cloud Storage bucket for PDFs
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` - Payment processing
- `STRIPE_PRO_PRICE_ID`, `STRIPE_PRO_PRICE_ID_MXN` - Subscription prices
- `ADMIN_EMAILS` - Comma-separated admin emails
- `CRON_SECRET_KEY` - Secret for scheduled job authentication

## Code Conventions

- ESM modules (`"type": "module"` in package.json)
- All imports use `.js` extension (required for ESM)
- DTOs use class-validator decorators
- Firestore timestamps stored as ISO strings
- Timezone: GMT-6 (Mérida, México) for daily metrics
- Error codes defined in `common/constants/error-codes.ts`
