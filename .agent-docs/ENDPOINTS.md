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
| POST | /users/me/photo | User | UsersController.uploadPhoto | Upload the profile photo (multipart, campo `file`) |
| DELETE | /users/me/photo | User | UsersController.deletePhoto | Remove the profile photo (204) |
| DELETE | /users/me | User | UsersController.deleteAccount | Baja de cuenta (irreversible) |
| GET | /users/me/preferences | User | UsersController.getPreferences | Preferencias de notificación |
| PUT | /users/me/preferences | User | UsersController.updatePreferences | Actualizar preferencias (parcial) |
| GET | /users/verification-status | User | UsersController.getVerificationStatus | Check email verification status |
| GET | /users/limits | User | UsersController.getUserLimits | Get plan limits and current usage |
| GET | /users/history | User | UsersController.getUserHistory | Get conversion history (Pro+ only) |
| DELETE | /users/history/:id | User | UsersController.deleteHistoryEntry | Delete a history record (Pro+ only) |
| GET | /users/history/:id/zpl | User | UsersController.getHistoryZpl | Get the original ZPL to reconvert (Pro+ only) |

**File:** `src/modules/users/users.controller.ts`

### Foto de perfil

`POST /users/me/photo` recibe `multipart/form-data` con el campo `file` y responde
`{ photoURL }`. Acepta JPEG, PNG y WebP —decidido por el contenido del archivo, no
por el `Content-Type`— hasta 2 MB (`IMAGE_TOO_LARGE`, 413); el resto se rechaza con
`UNSUPPORTED_IMAGE_TYPE` (400).

La imagen se recorta a cuadrado y se reescala a 256 px en WebP, y se guarda siempre
en `users/<uid>/avatar.webp` del bucket **público** (`GCP_PUBLIC_BUCKET`, por defecto
`zplpdf-public-assets`): la ruta fija evita huérfanos y el bucket público evita las
URLs firmadas, que caducarían. La URL devuelta lleva `?v=<timestamp>` para invalidar
la caché del navegador.

La URL se escribe en Firestore **y** en Firebase Auth (`updateUser`), en ese orden
inverso —Auth primero—: el claim `picture` del token es lo que pinta el frontend, y
si solo se guardara en Firestore seguiría mostrando la foto de Google.

`DELETE /users/me/photo` borra el objeto y deja `photoURL: null` en ambos sitios, que
es lo que devuelve al usuario a sus iniciales; `null` (y no el campo ausente) es lo
que distingue "la quitó" de "nunca subió ninguna", el caso en que `GET /users/me` sí
cae en la foto del proveedor de acceso.
### Baja de cuenta (`DELETE /users/me`)

Lógica en `src/modules/users/account-deletion.service.ts`. Encadena, **en este orden**:

1. Cuenta las facturas de Stripe que van a conservarse.
2. **Cancela las suscripciones vivas** (inmediata, no a fin de periodo). Mira el
   `stripeSubscriptionId` guardado **y** las del `stripeCustomerId`: el id local puede
   faltar o estar desfasado, y fiarse solo de él dejaría un contrato cobrando a una
   cuenta borrada. Si Stripe rechaza cualquiera, la petición muere aquí con
   `409 SUBSCRIPTION_CANCEL_FAILED` y **no se borra nada**.
3. Escribe `deleted_accounts/<uid>` con `deletedAt`. Esta lápida bloquea desde ese
   instante las autorizaciones y las escrituras tardías de conversiones/batches. Las
   creaciones persistentes (historial, uso, cola, batches y localizadores) la leen en
   la misma transacción con la que guardan el dato. Las actualizaciones de progreso
   usan `update()` directo: no recrean un doc barrido ni pagan lecturas por avance.
   Si la marca falla después de cancelar Stripe, la respuesta es
   `ACCOUNT_DELETION_PARTIAL` con `failedSteps: ['deletionMark']`, no un 500 opaco.
4. Borra `conversion_history` y los archivos de Storage que cuelguen de la URL firmada
   de cada fila, más el prefijo `debug-zpl/<uid>/`, sus docs de `zpl_debug_files` y la
   foto de perfil (`users/<uid>/avatar.webp` del bucket **público**, #106): esa URL no
   está firmada ni caduca, así que es el archivo que más importa retirar.
   Los workers comprueban la lápida justo antes y después de cada subida a GCS; si la
   baja empieza durante la subida, retiran el objeto para que no quede huérfano tras
   este barrido.
5. Borra los batches (`zpl-batches` + los ZIP de `batches/<batchId>/`) y los docs de
   estado de `zpl-conversions`, que siguen sirviendo `GET /zpl/status/:jobId`.
6. Borra `usage`, el perfil fiscal (`tax_profiles`) y cancela los emails en cola.
7. Anonimiza lo que se conserva: los `cfdis`, los registros contables
   (`stripe_transactions`, `subscription_events`) y los de actividad (`email_queue`,
   `email_events`, `feedback`, `error_logs`) pasan a `userId: 'deleted_user'` con
   `userEmail` vacío. También quita el UID de `daily_stats.activeUserIds` sin alterar
   ningún contador y anonimiza `admin_audit_log.requestParams.userId`, conservando el
   resto del evento administrativo. El customer de Stripe pierde nombre, email,
   teléfono, domicilio, metadata y sus tax IDs. El XML/PDF timbrado NO se toca: es el
   documento fiscal. Tras borrar el perfil —y antes de borrar Firebase Auth— se repite
   el barrido, porque el webhook de cancelación puede escribir un `subscription_event`
   con PII mientras la baja avanza.
8. Borra el doc de `users` y, por último, la cuenta de Firebase Auth — **solo si
   ningún paso anterior falló**. Con datos o archivos pendientes, la identidad se
   conserva: es lo único que permite reintentar la baja, y sin ella esos restos
   quedarían sin dueño. Si el doc no llega a borrarse, tampoco se borra la cuenta de
   Auth.

`FirebaseAuthGuard` consulta la lápida en cada request y comprueba en Firebase Auth
que la cuenta existe **antes** de su "lazy user creation": un ID token sigue siendo
válido hasta una hora después de la baja, y sin esas dos redes la primera petición
posterior podría recrear el perfil. La comprobación de Auth solo se paga en el alta.

Respuesta 200: `{ deleted: { conversions, storedFiles, taxProfile, subscription:
{ cancelled, plan, effectiveAt } }, retained: { invoices, reason } }`. `reason` es un
código estable (`fiscal_retention`), no una frase: la app está en cuatro idiomas.

Si algún paso posterior a la cancelación falla, responde `500
ACCOUNT_DELETION_PARTIAL` con `data.accountDeleted` (si la cuenta llegó a
desaparecer) y `data.failedSteps`. El frontend necesita ese primer campo para no
afirmar que la cuenta ya no existe cuando sigue existiendo. Si Firebase Auth no se
borra, también se elimina `deleted_accounts/<uid>` para que el usuario conserve el
acceso y pueda reintentar.

### Preferencias de notificación (`/users/me/preferences`)

`{ notifications: { product, billing, usageReminders } }`, guardadas en el doc de
`users` (`notificationPreferences`). Ausente equivale a todo activado. El `PUT` es
parcial: las claves que no vengan conservan su valor, y la respuesta trae siempre las
tres resueltas. Se escriben con ruta anidada (`notificationPreferences.product`) para
que dos clics seguidos en la pantalla de ajustes no se pisen; después se relee el
documento y se devuelve el estado completo realmente persistido, incluidos cambios
concurrentes en otras claves.

`EmailService.processQueue` las comprueba **justo antes de enviar** —no solo al
encolar, porque las secuencias se programan con días de antelación— usando el mapa
`EMAIL_NOTIFICATION_CATEGORY` (`src/modules/email/email-categories.ts`). Lo que no
sale se marca `cancelled` con su `skipReason` y cuenta en `skipped`, no en `failed`.
Justo antes de llamar a Resend, el worker reclama atómicamente el documento con
`pending -> sending`; si una baja u otro worker cambió ya su estado, no envía ni lo
sobrescribe a `sent`, y ese elemento también cuenta en `skipped`.

### Acciones sobre el historial

`:id` es el **doc id de `conversion_history`** (no el `jobId`), y viene en el campo
`id` de cada ítem de `GET /users/history`.

- **Ownership:** un registro ajeno responde `404 HISTORY_NOT_FOUND`, igual que uno
  inexistente. Un `403` confirmaría que el id existe.
- **Borrado real**, y no toca `usage`: si borrar filas descontara PDFs del período,
  cualquiera reiniciaría su cuota vaciando el historial. Las métricas viven agregadas
  en `daily_stats` / `global_totals`, así que tampoco se ven afectadas. Sí pierden la
  fila los consumidores que leen `conversion_history` en crudo: `getTopUsers`,
  `getUserUsageHistory`, `getUsersWithHighUsage` y `getConversionsPaginated` (la
  lista de `/admin/conversions`). El PDF de Cloud Storage se queda donde está.
- **Retención del ZPL: 15 días** (`ZPL_RETENTION_DAYS`). No la decide la aplicación:
  la impone una regla de lifecycle del bucket `zplpdf-app-files` que borra el prefijo
  `debug-zpl/` a los 15 días (`gsutil lifecycle get gs://zplpdf-app-files`). Si se
  cambia esa regla hay que actualizar la constante.
- Pasada esa ventana, `GET /users/history/:id/zpl` responde `410 ZPL_NOT_AVAILABLE`.
  Para no descubrirlo a base de errores, cada ítem de `GET /users/history` trae
  `canReconvert: boolean`. Exige que el ZPL se llegara a guardar (una consulta en lote
  a `zpl_debug_files`, solo con los jobIds de la página; los docs usan el jobId como
  id), que siga dentro de la ventana —contada desde que se guardó el ZPL, no desde la
  fila del historial— y que su `fileSize` conocido no supere
  `MAX_RECONVERTIBLE_ZPL_SIZE_BYTES`. Un tamaño ausente no bloquea metadata antigua.
  Las filas creadas por batch **antes** de agosto de 2026 no tienen ZPL: el flujo
  batch registraba historial sin llamar a `saveZplForDebug`. Salen con
  `canReconvert: false` para siempre.
- El listado sirve de una caché en memoria de 60s (`historyScanCache`, issue #89), así
  que `deleteHistoryEntry` la invalida: sin eso la fila borrada reaparecería en la
  siguiente carga de la tabla.
- El ZPL **no** está en Firestore: `ConversionStatus.zplContent` existe en el tipo pero
  nunca se escribe. La copia real vive en `debug-zpl/{userId}/{fecha}/{jobId}.zpl`,
  indexada por jobId en `zpl_debug_files`.
- La reconversión no tiene endpoint propio: el frontend precarga el ZPL y usa el flujo
  normal `POST /zpl/convert`, que es donde se aplican los límites de plan.

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
