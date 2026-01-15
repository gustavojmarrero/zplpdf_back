# API Endpoints Reference

All endpoints are prefixed with `/api` (configured in `main.ts`).

## Health Check
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | / | None | AppController.getHello | Health check |

## ZPL Conversion (`/zpl`)

| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /zpl/convert | User | ZplController.convertZpl | Start async ZPL to PDF/PNG/JPEG conversion |
| POST | /zpl/process | None | ZplController.processZpl | Internal: process conversion (Cloud Tasks) |
| GET | /zpl/status/:jobId | None | ZplController.checkStatus | Check conversion job status |
| GET | /zpl/queue-position/:jobId | None | ZplController.getQueuePosition | Get position in Labelary queue |
| GET | /zpl/download/:jobId | User | ZplController.downloadPdf | Get signed download URL |
| POST | /zpl/count-labels | User | ZplController.countLabels | Count labels in ZPL content |
| POST | /zpl/preview | User | ZplController.previewZpl | Generate PNG preview images |
| POST | /zpl/validate | User | ZplController.validateZpl | Validate ZPL syntax without conversion |
| POST | /zpl/batch/convert | User | ZplController.batchConvert | Batch conversion (Pro/Enterprise only) |
| GET | /zpl/batch/status/:batchId | None | ZplController.getBatchStatus | Check batch job status |
| GET | /zpl/batch/download/:batchId | User | ZplController.getBatchDownload | Download batch ZIP file |

**File:** `src/modules/zpl/zpl.controller.ts`

## Users (`/users`)

| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /users/sync | User | UsersController.syncUser | Sync Firebase user with Firestore |
| GET | /users/me | User | UsersController.getUserProfile | Get current user profile |
| GET | /users/verification-status | User | UsersController.getVerificationStatus | Check email verification status |
| GET | /users/limits | User | UsersController.getUserLimits | Get plan limits and current usage |
| GET | /users/history | User | UsersController.getUserHistory | Get conversion history (Pro+ only) |

**File:** `src/modules/users/users.controller.ts`

## Payments (`/payments`)

| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /payments/create-checkout | User | PaymentsController.createCheckout | Create Stripe Checkout session |
| POST | /payments/portal | User | PaymentsController.createPortal | Create Stripe Customer Portal session |
| POST | /payments/upgrade | User | PaymentsController.upgradeSubscription | Upgrade PRO → PRO MAX |

**File:** `src/modules/payments/payments.controller.ts`

## Billing (`/billing`)

| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /billing/invoices | User | BillingController.getInvoices | Get user's Stripe invoices |
| GET | /billing/payment-methods | User | BillingController.getPaymentMethods | Get saved payment methods |
| GET | /billing/subscription | User | BillingController.getSubscription | Get subscription details |

**File:** `src/modules/billing/billing.controller.ts`

## Webhooks (`/webhooks`)

| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /webhooks/stripe | Stripe Sig | WebhooksController.handleStripeWebhook | Handle Stripe events |

**File:** `src/modules/webhooks/webhooks.controller.ts`

## Contact (`/contact`)

| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /contact/enterprise | None | ContactController.createEnterpriseContact | Enterprise contact form |

**File:** `src/modules/contact/contact.controller.ts`

## Errors (`/errors`)

| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /errors | None | ErrorsController.logError | Log frontend/system errors |

**File:** `src/modules/errors/errors.controller.ts`

## Email (`/email`)

### Cron Endpoints (Cloud Scheduler)
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /email/cron/process-email-queue | Cron | EmailController.processQueue | Process email queue |
| POST | /email/cron/schedule-onboarding-emails | Cron | EmailController.scheduleOnboarding | Schedule onboarding emails |
| POST | /email/cron/initialize-ab-variants | Cron | EmailController.initializeAB | Initialize A/B test variants |
| POST | /email/cron/schedule-high-usage-emails | Cron | EmailController.scheduleHighUsage | High usage notifications |
| POST | /email/cron/schedule-retention-emails | Cron | EmailController.scheduleRetention | Retention campaign emails |
| POST | /email/cron/schedule-power-user-emails | Cron | EmailController.schedulePowerUser | Power user notifications |
| POST | /email/cron/schedule-free-reactivation-emails | Cron | EmailController.scheduleReactivation | Reactivation emails |

### Event Triggers
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /email/email/trigger-blocked | Internal | EmailController.triggerBlocked | Send blocked email alert |
| POST | /email/webhooks/resend | Resend Sig | EmailController.handleResendWebhook | Handle Resend events |

### Admin Endpoints
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /email/admin/email-metrics | Admin | EmailController.getMetrics | Email campaign metrics |
| GET | /email/admin/email-metrics/ab-test | Admin | EmailController.getABTestMetrics | A/B test results |
| GET | /email/admin/email-metrics/by-type | Admin | EmailController.getMetricsByType | Metrics by email type |
| GET | /email/admin/email-metrics/funnel | Admin | EmailController.getFunnel | Email funnel analysis |
| GET | /email/admin/users/pro/inactive | Admin | EmailController.getInactiveProUsers | Inactive Pro users |
| GET | /email/admin/users/pro/power-users | Admin | EmailController.getPowerUsers | Power users list |
| GET | /email/admin/users/free/inactive | Admin | EmailController.getInactiveFreeUsers | Inactive free users |

**File:** `src/modules/email/email.controller.ts`

### Email Templates
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /email/templates | Admin | EmailTemplatesController.getTemplates | List all templates |
| GET | /email/templates/:id | Admin | EmailTemplatesController.getTemplate | Get template by ID |
| PUT | /email/templates/:id | Admin | EmailTemplatesController.updateTemplate | Update template |
| GET | /email/templates/:id/history | Admin | EmailTemplatesController.getHistory | Template version history |
| POST | /email/templates/:id/rollback | Admin | EmailTemplatesController.rollback | Rollback to version |
| POST | /email/templates/:id/test | Admin | EmailTemplatesController.sendTest | Send test email |
| GET | /email/templates/:id/preview | Admin | EmailTemplatesController.preview | Preview rendered HTML |

**File:** `src/modules/email/email-templates.controller.ts`

## Cron Jobs (`/cron`)

| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /cron/reset-usage | Cron | CronController.resetUsage | Reset monthly usage counters |
| POST | /cron/cleanup-errors | Cron | CronController.cleanupErrors | Delete old error logs |
| POST | /cron/update-exchange-rates | Cron | CronController.updateExchangeRates | Update USD/MXN rates |
| POST | /cron/generate-recurring-expenses | Cron | CronController.generateExpenses | Generate recurring expenses |
| POST | /cron/update-goals | Cron | CronController.updateGoals | Update monthly goals |
| POST | /cron/check-inactive-users | Cron | CronController.checkInactive | Check inactive users |
| POST | /cron/migrate-subscription-periods | Cron | CronController.migratePeriods | Migrate subscription data |
| POST | /cron/reset-us-countries | Cron | CronController.resetUSCountries | Reset geo data |

**File:** `src/modules/cron/cron.controller.ts`

## Admin Dashboard (`/admin`)

### Metrics & Overview
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/metrics | Admin | AdminController.getMetrics | Dashboard summary metrics |
| GET | /admin/plan-usage | Admin | AdminController.getPlanUsage | Plan usage breakdown |
| GET | /admin/plan-changes | Admin | AdminController.getPlanChanges | Plan change history |
| GET | /admin/consumption-projection | Admin | AdminController.getProjection | Usage projection |

### Users Management
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/users | Admin | AdminController.getUsers | Paginated users list |
| GET | /admin/users/:userId | Admin | AdminController.getUserDetail | User details |
| PATCH | /admin/users/:userId/plan | Admin | AdminController.updateUserPlan | Change user plan |

### Conversions
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/conversions | Admin | AdminController.getConversions | Conversion statistics |
| GET | /admin/conversions/list | Admin | AdminController.getConversionsList | Individual conversions |

### Errors
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/errors | Admin | AdminController.getErrors | Error logs list |
| GET | /admin/errors/stats | Admin | AdminController.getErrorStats | Error statistics |
| GET | /admin/errors/:id | Admin | AdminController.getErrorDetail | Error details |
| PATCH | /admin/errors/:id | Admin | AdminController.updateError | Update error status |

### Plan Simulation
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| POST | /admin/simulate-plan | Admin | AdminController.simulatePlan | Start plan simulation |
| GET | /admin/simulate-plan/status | Admin | AdminController.getSimulationStatus | Simulation status |
| POST | /admin/simulate-plan/stop | Admin | AdminController.stopSimulation | Stop simulation |

### Labelary Stats
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/labelary-stats | Admin | AdminController.getLabelaryStats | Labelary API statistics |
| GET | /admin/labelary-metrics | Admin | AdminController.getLabelaryMetrics | Detailed Labelary metrics |

### Finance
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/revenue | Admin | AdminController.getRevenue | Revenue summary |
| GET | /admin/revenue/breakdown | Admin | AdminController.getRevenueBreakdown | Revenue breakdown |
| GET | /admin/transactions | Admin | AdminController.getTransactions | Stripe transactions |
| GET | /admin/mrr-history | Admin | AdminController.getMRRHistory | MRR history |

### Expenses
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/expenses | Admin | AdminController.getExpenses | List expenses |
| POST | /admin/expenses | Admin | AdminController.createExpense | Create expense |
| PATCH | /admin/expenses/:id | Admin | AdminController.updateExpense | Update expense |
| DELETE | /admin/expenses/:id | Admin | AdminController.deleteExpense | Delete expense |
| GET | /admin/expenses/summary | Admin | AdminController.getExpensesSummary | Expenses summary |

### Goals
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/goals | Admin | AdminController.getGoals | Current goals |
| POST | /admin/goals | Admin | AdminController.setGoals | Set monthly goals |
| GET | /admin/goals/progress | Admin | AdminController.getGoalsProgress | Goals progress |
| GET | /admin/goals/alerts | Admin | AdminController.getGoalsAlerts | Goals alerts |
| GET | /admin/goals/history | Admin | AdminController.getGoalsHistory | Goals history |

### Geo Analytics
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/geo/distribution | Admin | AdminController.getGeoDistribution | User distribution by country |
| GET | /admin/geo/conversion-rates | Admin | AdminController.getGeoConversionRates | Conversion by country |
| GET | /admin/geo/revenue | Admin | AdminController.getGeoRevenue | Revenue by country |
| GET | /admin/geo/potential | Admin | AdminController.getGeoPotential | Market potential |

### Business Metrics
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/metrics/churn | Admin | AdminController.getChurnMetrics | Churn rate metrics |
| GET | /admin/metrics/ltv | Admin | AdminController.getLTVMetrics | Customer LTV |
| GET | /admin/metrics/profit | Admin | AdminController.getProfitMetrics | Profit metrics |
| GET | /admin/finance/dashboard | Admin | AdminController.getFinanceDashboard | Finance dashboard |

### Business Valuation
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/valuation | Admin | AdminController.getValuation | Current business valuation |
| GET | /admin/valuation/history | Admin | AdminController.getValuationHistory | Valuation history |

### ZPL Debug
| Method | Path | Auth | Controller | Description |
|--------|------|------|------------|-------------|
| GET | /admin/zpl-debug | Admin | AdminController.getZplDebugFiles | List debug ZPL files |
| GET | /admin/zpl-debug/:jobId/download | Admin | AdminController.downloadZplDebug | Download debug file |

**File:** `src/modules/admin/admin.controller.ts`

---

## Authentication Types

| Type | How to Apply | Header Required |
|------|--------------|-----------------|
| **User** | `@UseGuards(FirebaseAuthGuard)` | `Authorization: Bearer <firebase_id_token>` |
| **Admin** | `@UseGuards(AdminAuthGuard)` | `Authorization: Bearer <token>` + `X-Admin-Email` |
| **Cron** | `@UseGuards(CronAuthGuard)` | `X-Cron-Secret: <CRON_SECRET_KEY>` |
| **Stripe Sig** | Custom validation in handler | `Stripe-Signature` header |
| **None** | No guard | Public endpoint |
