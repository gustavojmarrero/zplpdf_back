# BE02 · BE03 · A02–A06 — contrato de métricas y COE

Estado: implementado en `src/modules/growth-metrics/**`. **No desplegado, ningún job creado ni habilitado, ninguna llamada real a Stripe y ningún dato de producción.** Esta revisión audita y corrige la implementación anterior; lo que sigue describe lo que el código hace hoy y lo que deliberadamente **no** afirma.

`calculationVersion` pasa de `growth-v1` a `growth-v2`: los snapshots anteriores no son comparables con los nuevos porque cambia la definición de la marca de agua y de la cobertura.

## 1. Defectos corregidos en esta revisión

| # | Defecto | Consecuencia que tenía | Corrección |
|---|---|---|---|
| 1 | El snapshot y `latest` se escribían **antes** de comprobar el token del lease | Un proceso con el lease vencido publicaba su resultado y podía hacer retroceder `latest` | `LeaseFence.assert()` se ejecuta como primera lectura de la **misma** transacción que publica (`growth-sources.ts`); si el lease es de otro, la transacción no escribe nada |
| 2 | Igual en el inventario de facturación: `growth_paid_stocks/latest` se escribía antes del control de lease | Un inventario adelantado podía sobrescribir al vigente | `publishInventory` publica el histórico y `latest` dentro de una transacción que comprueba el lease del job **y** el de la conciliación |
| 3 | La frescura se comprobaba con `cutoff - observedAt < 36h`, que **también es cierto para observaciones futuras** (edad negativa) | El backfill de 7 días sellaba el inventario y la conciliación de **hoy** dentro de snapshots de hasta 6 días antes | `observationUsableAt()` exige `0 ≤ edad < frescura`; el snapshot histórico marca `inventory_after_cutoff` y publica `missing_data` |
| 4 | `sourceWatermark` era el fin de la ventana del planificador | Se afirmaba cobertura hasta una hora del reloj, sin mirar las fuentes | `resolveSourceWatermark()` devuelve el mínimo de las marcas **reales** (cola drenada + conciliación terminada antes del corte) y `null` si alguna falta |
| 5 | `min(null, cutoff)` devolvía el corte | Sin ningún hecho ingerido se publicaba la hora del reloj como marca | Sin hechos ingeridos no hay marca de eventos (`no_event_watermark`) |
| 6 | El atraso de `label_event_retries` (hechos de BE04/BE05) no se miraba | Un snapshot podía declararse completo con hechos de exportación sin entregar | A02 y A03 consultan pendientes y muertos de **las dos** colas; cualquiera de ellas bloquea la cobertura |
| 7 | `growth_first_payments` guardaba el mínimo observado sin decir de dónde salía | Con solo webhooks, el «primer pago» puede ser el segundo, y una cuenta que ya pagaba contaba como conversión | Campo `coverage` (`webhook_only` / `reconciled_history`); con cobertura parcial `calculatePaid30d` devuelve `missing_data`, no una tasa |
| 8 | `initiallyPaid` ausente se leía como «no pagaba» (`!undefined`) | Una asignación sin el dato entraba al denominador de intención de tratar e inflaba la conversión | Solo `initiallyPaid === false` entra; los desconocidos se cuentan en `excludedUnknownInitialState` |
| 9 | No había exclusión de cuentas de QA, administración ni cortesías | Una activación de QA contaba como adopción (el plan §5 lo prohíbe) | `loadExclusionPolicy()` sobre `GROWTH_EXCLUDED_ACCOUNT_IDS` + colección `growth_excluded_accounts`, aplicada a eventos, asignaciones, pagos y candidatos de feedback |
| 10 | La atribución pendiente se resolvía sin filtrar `livemode` | Un hecho de prueba podía resolverse contra una cuenta de producción | `reconcileBilling` filtra por modo y reporta `stillPending` y `truncated` |
| 11 | No existía ledger de reembolsos ni de ingreso por moneda | No se podía distinguir ingreso bruto de neto, y sumar monedas habría producido un número inventado | `revenue-ledger.ts` + ingesta de `charge.refunded`; filas por moneda y **sin total** |
| 12 | `subscriptions.list` no tenía tope temporal | El inventario mezclaba objetos creados durante el propio recorrido | Mismo `created.lte` que las facturas: el inventario es la observación de un intervalo acotado |
| 13 | `isPaid` exigía un primer pago registrado sin decirlo | Un pagador antiguo sin registro quedaba fuera del inventario como si no pagara | Campo `paidEvidence` (`reconciled_history` / `webhook_only` / `missing_first_payment`) |

Hallazgo para root, **fuera de mis rutas**: en la versión Basil de la API de Stripe el objeto `Charge` ya no expone `invoice`. Cualquier código que haga `charge.invoice` con un cast obtiene `undefined` en silencio. Aquí se guarda `paymentIntentId` y se declara `invoiceLinkStatus: 'requires_read_api_lookup'` en vez de fingir la ligadura.

## 2. Qué se afirma y qué no

- **Asociación, nunca causalidad.** Todo snapshot con cobertura completa lleva `reason: 'descriptive_not_causal'`. No hay ningún camino que declare un «ganador».
- **Existencias ≠ conversión.** `paidAccountStock` es una foto de suscripciones pagas en un instante, con `paidAccountStockSemantics: 'point_in_time_stock_not_conversion'`. Una cuenta puede estar en el inventario sin un solo evento de uso, y al revés.
- **Ventanas propias.** El inventario y la conciliación tienen su propia ventana de observación; no se proyectan hacia atrás ni hacia adelante.
- **Ausencia de dato no es cero.** Sin denominador, `status: 'insufficient_data'`; sin fuente, `missing_data`. Ningún indicador cae a `0` por falta de observación.
- **No se suman cuentas entre funcionalidades.** `paid30dByAssignment` devuelve `convertedAccountCount` y el snapshot lleva `distinctConvertedAccounts` (cuentas distintas en todas las funcionalidades) más `crossFeatureSemantics: 'do_not_sum_converted_accounts_across_features'`.
- **Sin identificadores ni texto libre en lo publicado.** Ver §11.
- **Cancelación futura ≠ baja.** El inventario guarda `cancellationScheduled` como indicador anticipado; la baja efectiva sale del puente de existencias.
- **Contraseñales.** `counterSignals` reúne atrasos, muertos, atribución pendiente y truncados. **No son crecimiento y no se restan de él**: son la razón por la que una tasa puede no significar lo que parece.

## 3. Marca de agua y cobertura

```ts
resolveSourceWatermark({ cutoff, maxEventReceivedAt, eventBacklog,
  labelEventBacklog, deadEvents, billingWatermark, billingCompletedAt, truncated })
  => { sourceWatermark, eventWatermark, billingWatermark, lastIngestedAt, blockers, coverage }
```

- **Eventos:** lo que acota el conocimiento no es el último hecho que llegó —un sistema tranquilo no deja de saber— sino que la cola esté drenada. Con pendientes, muertos o truncado: `null`. Sin ningún hecho ingerido: `null` (no se puede afirmar que un canal esté drenado si nunca se ha visto pasar nada). `lastIngestedAt` se publica como evidencia, no como cota.
- **Facturación:** aporta marca solo si su conciliación terminó **antes** del corte y dentro de 36 h. Una conciliación posterior conoce cobros que ese día no se conocían.
- **Resultado:** `sourceWatermark = min(eventWatermark, billingWatermark)`, nunca posterior al corte, `null` si falta cualquiera de las dos.

Códigos de bloqueo (`blockers`): `event_backlog`, `label_event_backlog`, `dead_events`, `scan_limit`, `billing_incomplete`, `billing_stale`, `billing_attribution_pending`, `first_payment_coverage_partial`, `inventory_missing`, `inventory_after_cutoff`, `cohort_start_not_configured`, `no_event_watermark`.

## 4. Automatizaciones (A02–A06)

Ninguna está creada ni habilitada. Los handlers existen bajo `POST /cron/growth/:job` con `GrowthSchedulerGuard`.

| ID | Job | Publica | Bloquea si |
|---|---|---|---|
| A02 | `quality` | `growth_quality/latest` | siempre `canEvaluateGrowth: false`; `degraded` con pendientes o muertos de cualquiera de las dos colas |
| A03 | `aggregate` | `growth_snapshots/{día}_{versión}` y `latest` | cualquier `blocker`; recomputa 7 días y publica `latest` al final |
| A04 | `billing-reconcile` | `billing_facts`, `growth_paid_stocks`, `growth_billing_sync` | sin clave de lectura devuelve `missing_data`; `unresolved > 0` impide `complete` |
| A05 | `panel` | `growth_panel_receipts/latest` | `blockers` propios: uso, cobertura, facturación, primer pago, calidad, frescura |
| A06 | `feedback` | `in_app_feedback_candidates` | cadencia global de 30 días; solo elegibilidad dentro de la app, ningún envío |

Cada ejecución guarda `runId`, ventana UTC, `timezone: 'America/Merida'`, `calculationVersion`, `sourceWatermark`, `checksum`, estado, cursor, lease e intentos en `growth_job_runs`. Reejecutar la misma ventana no duplica nada: el identificador de la ventana es determinista y una ventana `completed` no se vuelve a ejecutar. Tope de **8 intentos** por ventana; al agotarse, `status: 'dead'` con `ATTEMPTS_EXHAUSTED` y sin reintento automático. Un lease perdido se distingue de un fallo (`LEASE_LOST` vs `JOB_FAILED`) y **no** marca el documento de otro proceso.

## 5. Alcance financiero completado

Lo que en la revisión anterior figuraba como pendiente externo ya está implementado. Nada de esto se ha ejecutado contra Stripe ni contra datos reales: falta de credenciales sigue siendo `missing_data`, no falta de código.

### Reembolsos con cobertura histórica

La conciliación tiene ahora **tres fases** con cursor propio: `invoices` → `subscriptions` → `refunds` → `completed`. Los reembolsos se recorren con `refunds.list({ created: { lte: readStartedAt }, limit: 100, starting_after })`.

- Cada objeto `re_…` es una **línea autoritativa** del libro (`billing_facts/stripe_refund_<id>`, `type: 'refund_observed'`, `countedInLedger: true`). Dos devoluciones parciales del mismo cargo son dos líneas: no hay acumulados que interpretar.
- El hecho que deja `charge.refunded` (`type: 'charge_refunded'`) baja a **señal**: `countedInLedger: false`, `ledgerRole: 'refund_signal_requires_reconciliation'`. Motivo: `charge.refunds` es una lista paginada que puede llegar truncada, así que de ahí no se puede deducir el total de devoluciones. Sirve para saber que ese cargo hay que conciliar.
- `revenueLedger.coverage` solo es `complete` cuando `refundPhaseComplete` es verdadero; si no, `partial` con `coverageReason: 'refund_history_not_walked'`. Un neto calculado sin recorrer el histórico estaría por encima del real.
- Un reembolso con `status` distinto de `succeeded`/`pending` no devolvió dinero y no entra.

### Renovación mensual y anual

`renewals` en el snapshot, calculado por `calculateRenewals`:

- **Denominador:** suscripciones cuyo `currentPeriodEnd + graceDays` ya pasó **antes de la marca de agua**. `GROWTH_RENEWAL_GRACE_DAYS` (por defecto 7).
- **Numerador:** solo facturas `subscription_cycle` pagadas. `subscription_create` es el primer pago y no cuenta como renovación.
- **Cero vs ausencia:** sin cohorte madura, `insufficient_data` con `denominator: 0`; sin cobertura de facturas, `missing_data`. Ninguno es «0% de renovación».
- `pendingGrace` cuenta las vencidas cuya gracia aún corre: ni renovadas ni perdidas. `cancellationScheduled` sigue siendo indicador anticipado.
- El período se lee de `subscription.items.data[].current_period_end`: en la API Basil **ya no está** en la suscripción, y leerlo del objeto raíz habría dejado la cohorte vacía para siempre con un `undefined` silencioso. Con items de períodos distintos se toma el más temprano y se marca `mixedPeriods`.

### Enterprise manual

`enterpriseSegment`, a partir de la fuente interna observada (`users.plan === 'enterprise'`) cruzada con el inventario de Stripe:

- Manual = Enterprise interno que **no** aparece en el inventario. Quien ya está en Stripe se cuenta allí (`accountsAlreadyInStripe`) y nunca aquí.
- Sin inventario con cobertura completa el segmento entero es `missing_data`: sin saber quién ya está contado, publicar el total como «manual» duplicaría clientes.
- El ingreso solo existe si hay contrato declarado en `growth_enterprise_contracts` para el período, con moneda, importe y `basis` (`invoiced` o `declared`). Sin contrato la cuenta se cuenta como cuenta y el dinero es `missing_data`.
- `doNotSumWithStripe: true` viaja en el documento: el consumidor no puede sumarlo al inventario por descuido.

### Economía: costes y contribución

`economics`, a partir de `growth_cost_entries` (`period`, `category` ∈ renderer|cloud|connector|support, `currency`, `amountMinor`, `source`, `basis`, `observedAt`):

- La contribución (`netRevenueMinor − costTotalMinor`) se publica **solo** con las cuatro categorías presentes en esa moneda **y** el ingreso con cobertura completa. Con tres de cuatro, `contributionMinor: null` y `reason: 'missing_cost_categories:…'`: un neto incompleto parece completo y engaña más que un hueco.
- Una categoría sin entradas es `missing_data`, no coste cero: nadie ha declarado que ese mes no se gastara nada en renderer.
- **Nunca se suma entre monedas** y no existe total. Solo costes facturados o declarados: `estimatedCostsExcluded: true`, este módulo no estima nada.

### Fricciones operativas

`counterSignals.operational`, a partir de `growth_operational_signals` (lo escribe el interceptor de root):

- Son **intentos HTTP autenticados que fallaron**, no operaciones: no se suman ni se restan de los éxitos.
- Cobertura máxima `best_effort`, nunca `complete`: la anotación es de mejor esfuerzo y ante un fallo se registra `OPERATIONAL_SIGNAL_PERSIST_FAILED` sin romper la petición del usuario. Prometer un ledger exhaustivo sería falso.
- Sin `GROWTH_OPERATIONAL_SIGNALS_START`, o con una ventana que empieza antes de esa fecha, el agregado es `missing_data` con `quotaRejections: null`. Imputar historia convertiría la instrumentación misma en una caída de errores.
- Fuera por construcción: fallos de guard (sin cuenta autenticada no hay a quién atribuirlos) y fallos de trabajadores asíncronos (no son la petición de nadie). `excludedByDesign` lo declara, y ninguno de los dos entra en los libros de ingreso, coste ni renovación.

## 6. Rutas internas del planificador

`POST /api/internal/growth/*`, todas con `GrowthSchedulerGuard` (OIDC), ninguna pública y ninguna creada como job todavía.

| Ruta | Efecto |
|---|---|
| `label-events` | `LabelEventPublisher.retryPending(20)`: drena la cola de hechos de BE04/BE05 |
| `template-regression` | `TemplateRegressionService.recover()`: recuperación interna de BE10 |
| `drive-scan`, `drive-runs`, `drive-revoke`, `print-jobs`, `api-jobs`, `callbacks` | trabajos de F5/F6/F3, ya existentes |

Este módulo importa `WorkflowsModule` y `TemplateRegressionModule` **solo** para drenar sus colas; no publica ni altera sus datos.

## 7. Configuración

| Variable | Obligatoria | Efecto si falta |
|---|---|---|
| `GROWTH_COHORT_START` | sí para A03 | `cohort_start_not_configured`: sin features y sin marca |
| `GROWTH_EXCLUDED_ACCOUNT_IDS` | no | la política solo usa la colección; `source: 'empty'` |
| `GROWTH_STRIPE_READ_KEY` | no | A04 devuelve `missing_data`; **nunca** se usa una clave con permisos de escritura, y el prefijo debe coincidir con el modo (`rk_test_` / `rk_live_`). Solo lecturas: `invoices.list`, `subscriptions.list` y `refunds.list`; ninguna llamada crea, cobra ni reembolsa nada |
| `GROWTH_RENEWAL_GRACE_DAYS` | no | gracia de renovación; por defecto 7 días |
| `GROWTH_OPERATIONAL_SIGNALS_START` | sí para las fricciones | sin ella `counterSignals.operational` es `missing_data`, no cero |
| `PRODUCT_ENVIRONMENT` / `NODE_ENV` | sí | decide modo `live`/`test` de pagos e inventario |

Colecciones: `growth_event_facts`, `growth_account_feature_firsts`, `growth_assignments`, `growth_first_payments`, `billing_facts`, `growth_billing_sync`, `growth_paid_inventory_members`, `growth_paid_stocks`, `growth_snapshots`, `growth_quality`, `growth_panel_receipts`, `growth_job_runs`, `in_app_feedback_candidates`, `growth_excluded_accounts`, `growth_operational_signals`, `growth_cost_entries`, `growth_enterprise_contracts`.

Fuentes que alguien de operación mantiene a mano, y su forma exacta:

```ts
// growth_cost_entries/{id}
{ period: 'YYYY-MM', category: 'renderer'|'cloud'|'connector'|'support',
  currency: string, amountMinor: number, source: string,
  basis: 'invoiced'|'declared', observedAt: string }

// growth_enterprise_contracts/{id}
{ accountId: string, period: 'YYYY-MM', currency: string,
  amountMinor: number, source: string, basis: 'invoiced'|'declared' }

// growth_excluded_accounts/{accountId}
{ accountId: string }
```

### Índices

Solo hay **dos** consultas con más de un campo, y por tanto solo dos índices compuestos reales. Los demás filtros son de un solo campo y Firestore los indexa automáticamente: declararlos como compuestos habría sido inválido.

| Colección | Campos del índice compuesto | Consulta que lo necesita |
|---|---|---|
| `billing_facts` | `attributionStatus` (asc), `livemode` (asc) | atribución pendiente por modo (A04) |
| `billing_facts` | `livemode` (asc), `type` (asc), `occurredAt` (asc) | libro de ingresos y facturas de ciclo (A03/A04) |

Campos de un solo filtro, con índice automático: `growth_event_facts.receivedAt`, `growth_assignments.assignedAt`, `growth_account_feature_firsts.firstExposureAt`, `growth_first_payments.livemode`, `growth_paid_inventory_members.runId`, `growth_enterprise_contracts.period`, `growth_cost_entries.period`, `growth_operational_signals.occurredAt`, `event_outbox.state`, `event_outbox.availableAt`, `label_event_retries.availableAt`, `label_event_retries.status`, `users.plan`.

Los índices los declara root en el JSON del repositorio; aquí no se publica ningún comando con proyecto fijo, porque el proyecto de Firestore depende del entorno y un comando con el identificador escrito a mano se ejecuta en el equivocado.

TTL: `growth_event_facts` lleva `expiresAt` a 90 días y el job `retention` borra en lotes de 400 por colección. Los agregados (`growth_snapshots`, `growth_paid_stocks`) **no** caducan: son la evidencia de lo que se afirmó cada día. TTL no es borrado inmediato.

## 8. Evidencia

86 pruebas en `src/modules/growth-metrics` (`npx jest src/modules/growth-metrics`), con `tsc --noEmit` y `eslint --max-warnings=0` limpios sobre esa ruta. Sin red, sin credenciales y sin llamadas a Stripe: la conciliación se prueba con un doble de la API y un doble de Firestore que **exige lecturas antes de escrituras**, como la transacción real.

| Qué se prueba | Dónde |
|---|---|
| Un lease robado no publica `latest` ni toca el documento del nuevo dueño | `growth-aggregate.spec.ts` |
| El inventario de hoy no entra en un snapshot de días anteriores | `growth-aggregate.spec.ts` |
| La marca de agua sale de las fuentes y no de la hora del planificador | `growth-aggregate.spec.ts`, `growth-sources.spec.ts` |
| El atraso de la cola de BE04/BE05 bloquea la cobertura | `growth-aggregate.spec.ts` |
| Cuentas de QA excluidas del recuento | `growth-aggregate.spec.ts` |
| Primer pago solo de webhook ⇒ sin tasa de conversión | `growth-aggregate.spec.ts`, `cohort-metrics.spec.ts` |
| Asignación sin estado inicial ⇒ fuera del denominador | `cohort-metrics.spec.ts` |
| Alcance (expuestas/elegibles) y su ausencia declarada | `cohort-metrics.spec.ts` |
| Reembolso acumulado, reordenado y fuera de ventana | `revenue-ledger.spec.ts`, `billing-facts.service.spec.ts` |
| Monedas separadas y sin total | `revenue-ledger.spec.ts` |
| Factura cero y checkout no son primer pago | `billing-facts.service.spec.ts` |
| Cursor de Stripe que sobrevive a la muerte del proceso | `billing-reconciliation.service.spec.ts` |
| Histórico de reembolsos con cursor propio, reanudado, y cobertura total vs parcial | `billing-reconciliation.service.spec.ts` |
| Un fallo al anotar un reembolso no avanza el cursor | `billing-reconciliation.service.spec.ts` |
| Renovación mensual y anual con cohorte madura; gracia pendiente aparte | `finance-metrics.spec.ts`, `growth-aggregate.spec.ts` |
| Un primer pago no cuenta como renovación | `finance-metrics.spec.ts`, `growth-aggregate.spec.ts` |
| Cero renovaciones y ausencia de cohorte son estados distintos | `finance-metrics.spec.ts` |
| Período leído de los items (API Basil), no de la suscripción | `finance-metrics.spec.ts` |
| Enterprise manual separado, sin sumarse a Stripe y sin ingreso inventado | `finance-metrics.spec.ts`, `growth-aggregate.spec.ts` |
| Contribución solo con las cuatro categorías; moneda aislada | `finance-metrics.spec.ts`, `growth-aggregate.spec.ts` |
| Cuota y errores: `missing_data` sin instrumentación, nunca 0 | `finance-metrics.spec.ts`, `growth-aggregate.spec.ts` |
| Cobertura de fricciones con techo `best_effort` | `finance-metrics.spec.ts` |
| Ningún UID ni etiqueta de fuente en el documento publicado | `cohort-metrics.spec.ts`, `finance-metrics.spec.ts`, `growth-aggregate.spec.ts` |

### Pruebas contra el emulador real

Nueve pruebas en `test/growth-finance-emulator.test.ts` (configuración `test/growth-finance-emulator.jest.json`) corren contra el emulador de Firestore en `127.0.0.1:8085`, proyecto `demo-zplpdf-growth`. **Lo único simulado es Stripe**: las facturas y los reembolsos son objetos de fixture y no hay ninguna llamada a la API. Las transacciones, el `create` contra un documento existente, el lease con token entre **dos clientes `Firestore` distintos** y las consultas por `livemode` son reales.

```
JAVA_HOME=".local/tooling/jdk/jdk-21.0.12.1+1/Contents/Home" \
  npx --yes firebase-tools@15.30.1 emulators:exec --only firestore \
  --project demo-zplpdf-growth --config test/firebase-emulator.json \
  "npx jest --config test/growth-finance-emulator.jest.json --runInBand"
```

| Prueba | Qué demuestra |
|---|---|
| publica cuando el lease sigue siendo suyo | el camino feliz escribe `growth_quality/latest` |
| un lease robado por otro cliente impide publicar y deja `latest` intacto | el segundo cliente se queda la ventana en su propia transacción; el desahuciado no publica, `latest` conserva el valor anterior y el documento de ejecución mantiene el token ajeno sin `errorCode` |
| dos entregas de la misma factura dejan un solo hecho | dedup por id de factura con dos `eventId` distintos |
| el primer pago se queda con el más antiguo y su cobertura sube al conciliar | llega primero la factura posterior y el mínimo gana; `webhook_only` → `reconciled_history` |
| live y test no se mezclan | dos resúmenes (`live_`/`test_`) y el pago de prueba no adelanta el de producción |
| el mismo reembolso observado dos veces no se cuenta dos veces | un solo `stripe_refund_<id>` con `countedInLedger: true` |
| un reembolso fallido no devolvió dinero y no se registra | `status: 'failed'` no crea hecho |
| la cobertura del libro depende de haber recorrido el histórico | `partial` + `refund_history_not_walked` frente a `complete`, con bruto 50000, reembolsado 20000 y neto 30000 |
| el libro de producción no ve los hechos de prueba | aislamiento por `livemode` en la consulta del libro |

Las fechas de los fixtures son relativas al reloj (`now − 10 d`, `now − 2 d`), no fijas: el libro acota su ventana en `now`, así que una fecha fija haría que la prueba dependiera del día en que se ejecuta. Esa confusión salió justamente al ejecutar la suite por primera vez.

## 9. Retención (A12): qué no se barre

`retention` recorre una **allowlist** (`product_events`, `event_outbox`, `product_event_dedup`, `growth_event_facts`, `growth_operational_signals`), en lotes de **400 por colección y vuelta** —el resto espera la siguiente ejecución, así que el barrido está acotado y es reanudable—, y devuelve `protectedFromRetention` con lo que queda explícitamente fuera:

- **`label_event_retries` en `dead`**: es la evidencia de un hecho que ocurrió y no se pudo registrar; además esos documentos ya no tienen `expiresAt`. Barrerlo destruiría justo lo que hay que reconciliar.
- **Reservas de idempotencia vivas** (`label_workflow_exports`, `label_template_runs`, operaciones durables): borrar una reserva activa convierte un reintento en una segunda conversión cobrada.
- **Credenciales y tokens pendientes de revocación** (`api_credentials`, `integration_connections`): su baja tiene su propio flujo; una limpieza por tiempo los dejaría revocados a medias o vivos sin dueño.
- **Hechos y agregados financieros** (`billing_facts`, `growth_first_payments`, `growth_cost_entries`, `growth_enterprise_contracts`, `growth_paid_stocks`, `growth_snapshots`): son la evidencia de lo que se cobró y de lo que se afirmó. `growth_operational_signals` sí entra: tiene `expiresAt` a 90 días, no es reserva ni secreto, y perderlo no destruye evidencia financiera.
- **Colecciones de los módulos nuevos**, revisadas contra la política que publicó su dueño: `api_jobs` y `api_job_inputs` (hay contador de pendientes en vuelo), `drive_revocations` y `drive_oauth_states` (solo el `ack` caduca; lo pendiente o fallido guarda un token que todavía hay que revocar), `pdf_output_presets` y `pdf_output_preset_versions` (sin TTL por contrato). Ninguna se barre desde aquí.

**Un atraso se clasifica, nunca se resuelve borrando** (`backlogPolicy: 'classify_never_delete_protected'`): si una colección protegida acumula vencidos, este job lo reporta y lo deja para su dueño. Borrar un token pendiente de revocar dejaría un secreto vivo sin registro de que había que retirarlo. Y un recuento truncado o una cuenta eliminada nunca se presentan como «evidencia cero»: son `missing_data` con su motivo.

Los agregados publicados (`growth_snapshots`, `growth_paid_stocks`, `growth_panel_receipts`) tampoco caducan: son el registro de lo que se afirmó cada día. Añadir una colección a la allowlist exige comprobar antes que no es ninguna de esas tres cosas.

## 10. Privacidad de lo publicado

`growth_snapshots` y `growth_paid_stocks` los leen el panel de administración y el exportador, así que lo que entra ahí sale del proceso. Dos cosas que antes salían y ya no:

1. **Identificadores de cuenta.** `calculatePaid30d` devolvía `convertedAccounts: string[]`, un array de UID que acababa serializado dentro del snapshot. Ahora devuelve solo `convertedAccountCount`. Los UID siguen existiendo donde hacen falta —contar cuentas distintas entre funcionalidades— pero en un `Set` en memoria que el agregado pasa como acumulador y del que solo se publica el tamaño (`distinctConvertedAccounts`). Ningún documento publicado contiene un UID.
2. **Etiquetas libres de fuente.** `growth_cost_entries.source` y `growth_enterprise_contracts.source` los mantiene operación a mano, así que una etiqueta podía traer el correo del proveedor o una URL interna. El contrato ahora exige un **código de fuente cerrado**, `^[a-z][a-z0-9_-]{0,39}$`, y lo publicado es solo `sourceCount` y `basis` (enumerado cerrado). Una entrada con etiqueta que no cumple el código **sigue contando su importe** —el gasto es real— pero la etiqueta no se publica y se cuenta en `unsafeSourceLabels`, para que se vea que hay algo que corregir en el origen.

Las pruebas lo comprueban serializando el documento y buscando el UID y la etiqueta: `expect(JSON.stringify(latest)).not.toContain(...)`. Un cambio que vuelva a filtrarlos rompe una prueba en vez de aparecer en un panel.

## 11. Lo que falta y no se puede afirmar todavía

Todo lo pendiente es ahora **falta de credenciales, de datos o de una ventana de pruebas**, no falta de código.

1. **Ninguna llamada real a Stripe.** El código de las tres fases está probado con un doble de la API. Sin `GROWTH_STRIPE_READ_KEY` (restringida y del modo correcto) la conciliación devuelve `missing_data`. No se ha ejecutado contra Stripe, ni en test ni en live.
2. **Emulador: cubierto en lo financiero, no en todo.** Las nueve pruebas de §8 verifican contra el emulador real el fence de publicación con dos clientes y el histórico de facturas, reembolsos y primer pago con su aislamiento `live`/`test`. Lo que sigue probado **solo con dobles** es el resto del agregado: ventanas del backfill, exclusiones, cohortes de uso y el drenado de A02. No es un hueco de código, es alcance de prueba, y el puerto 8085 admite una sola instancia: ampliarlo exige otra ventana coordinada.
3. **Fuentes que alguien tiene que rellenar.** `growth_cost_entries`, `growth_enterprise_contracts` y `growth_excluded_accounts` están vacías: el código las lee y publica `missing_data` honesto mientras lo estén. La economía no aparecerá hasta que existan las cuatro categorías de coste del período.
4. **`GROWTH_OPERATIONAL_SIGNALS_START` sin fijar.** Hasta que se declare desde cuándo hay instrumentación, las fricciones son `missing_data`. No se imputa historia.
5. **Ledger de fricciones no exhaustivo por diseño.** La anotación es de mejor esfuerzo; su cobertura nunca será `complete` y el contrato lo dice en el propio documento publicado.
6. **GA4.** No se toca, ni se le envía ni se le lee nada financiero.
