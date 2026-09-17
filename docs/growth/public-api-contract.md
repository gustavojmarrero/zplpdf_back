# BE06 / A14 — API pública v1

Módulo `PublicApiModule`, prefijo global `/api`; integración AppModule por coordinador. Sin despliegue ni jobs externos habilitados.

Firebase management: `GET/POST /users/me/api-keys`, `DELETE /users/me/api-keys/:id`; create `{scopes:["jobs:write","jobs:read"]}` devuelve token `zpk_<id>.<secret>` una sola vez, después solo prefijo/id/scopes/timestamps. Hash SHA-256 de secreto aleatorio; revocación consultada en cada request. Cuenta del guard, nunca cuerpo. Flag self_service_api y plan del servidor para entradas nuevas. Máximo diez claves activas por cuenta.

Callbacks Firebase: `GET/POST /users/me/api-callbacks`, `DELETE /users/me/api-callbacks/:id`; create `{url:"https://..."}` devuelve signingSecret una sola vez. Se guarda AES-256-GCM usando `PUBLIC_API_ENCRYPTION_KEY` base64 de 32 bytes, requerida (sin fallback); mismo cifrado protege entradas temporales de jobs. Máximo cinco callbacks activos por cuenta. No se registran secretos, etiquetas ni URLs con credenciales/query; no redirects; solo HTTPS 443. DNS resuelto y verificado en cada intento y conexión fijada al IP público aprobado, manteniendo validación TLS del hostname.

API-key auth `Authorization: Bearer zpk_...`: `POST /v1/jobs` con scope jobs:write e `Idempotency-Key` de 1–128 caracteres seguros; cuerpo `{zplContent,labelSize,callbackId?}` o `{templateId,templateVersion,rows,labelSize,callbackId?}`. La misma clave por cuenta produce el mismo job entre instancias; distinto payload devuelve 409. `GET /v1/jobs/:id` y `/v1/jobs/:id/result` requieren jobs:read y propietario. `POST /v1/jobs/:id/cancel` y `/retry` requieren jobs:write y estado permitido. Aceptación 202 nunca afirma éxito; estados queued/running/succeeded/failed/cancelled, resultado solo al completar conversión real. Límite de intención y snapshot compilado juntos: 512 KiB; hasta 1000 filas, campos tipados del template, números rechazados para códigos que perderían ceros, labelSize debe coincidir con la versión. Entradas cifradas caducan a 15 días; metadata/outbox a 90 días, TTL requiere configuración externa.

Worker durable exportado procesa jobs y callbacks por lotes acotados; scheduler/OIDC lo integra root. Conversión real y cuota se reutilizan mediante adaptador del conversor existente con operationId estable; no se duplican cargos/cuota por retry. Al completar se persisten estado terminal, evento api_job_succeeded y callback outbox en transacción. ApiConversionAdapter usa ZplService.runDurableConversion (operationId=jobId) y su finalización durable/cuota idempotente; no consulta completion intermedio. ApiTemplateAdapter compone FirestoreTemplateRepository, mapRows y renderTemplate del dominio de plantillas, con owner check y versión inmutable. El ZPL de plantilla se materializa al aceptar y se cifra junto con la intención original; archivar posteriormente no impide recuperar un job ya admitido.

Callback payload sin etiqueta ni URL firmada: `{schemaVersion:1,eventId,eventName:"api_job.succeeded"|"api_job.failed",jobId,status,occurredAt}`. Cabeceras `X-ZPLPDF-Event-Id`, `X-ZPLPDF-Timestamp` Unix segundos, `X-ZPLPDF-Signature: v1=<hex HMAC-SHA256(timestamp+"."+rawBody)>`. Receptores verifican firma/ventana temporal y deduplican eventId; entrega al menos una vez con lease/token, backoff y máximo ocho intentos, estado dead visible. Nunca incluir contenido de etiquetas en callback.

Eliminación de cuenta debe barrer api_credentials/api_callback_endpoints/api_jobs/api_job_inputs/api_callback_deliveries/api_account_limits por accountId; referencias y TTL documentados aquí antes de habilitar. Tests locales con conversión/red simuladas no equivalen a evidencia de staging/proveedor.

Operación: `ApiJobsService.processDueJobs(limit=10)` y `ApiCallbacksService.dispatchCallbacks(limit=20)` son los handlers exportados que integra el coordinador en scheduler OIDC. La aceptación dispara un intento inmediato como optimización; la cola Firestore recupera caídas entre instancias. Lease de job diez minutos renovado cada 30 segundos, hasta ocho intentos; un OPERATION_IN_PROGRESS del bridge espera sin consumir otro intento. Solo un job queued sin intentos puede cancelarse; solo failed puede reintentarse explícitamente y conserva operationId/cuota. Las entradas ya aceptadas continúan aunque el flag se apague, y POST idempotente devuelve el job existente sin recrear ni renderizar. Resultado: URL nueva firmada por 15 minutos después de comprobar dueño y durable completion.

Callbacks: lease 30 segundos, DNS máximo dos segundos, petición máximo cinco segundos, cuerpo máximo 16 KiB, respuesta máximo 64 KiB. Se rechazan todas las direcciones de una resolución si cualquiera es privada/reservada; IPv6 exige rango global admitido y se rechazan mapped/ULA/link-local/multicast. TLS mantiene validación de certificado del hostname con socket fijado a dirección validada previamente; no se usan proxies ni redirecciones. Cada retry resuelve/verifica DNS de nuevo, mantiene eventId/payload y firma con timestamp nuevo. `GET /users/me/api-callbacks/:id/deliveries` muestra intentos/estado incluso tras revocar, sin secreto.

TTL a configurar en `expiresAt` nativo: api_job_inputs 15 días; api_jobs y api_callback_deliveries 90 días. api_credentials, api_callback_endpoints y api_account_limits permanecen hasta revocación/borrado de cuenta; revocar no elimina evidencia. Todas esas colecciones llevan accountId para el barrido de eliminación de cuenta del coordinador. No borrar/rotar PUBLIC_API_ENCRYPTION_KEY mientras existan secretos/jobs cifrados sin migrarlos; no hay fallback a plaintext. Consultas de colas usan solo availableAt; listados usan igualdad sobre accountId/callbackId e índices simples. Los listados están acotados a cien registros.

Validación local: pruebas de servicios/guards y adaptadores con Firestore transaccional simulado, DNS/HTTPS y renderer externo mockeados; incluyen concurrencia, recuperación, revocación, scope, ownership, HMAC, SSRF, timeout/size y JSON+plantilla con escape real. Quedan pruebas de integración con emulador/staging y proveedor real, configuración de TTL/secretos/OIDC/scheduler y verificación operativa; no se realizaron despliegues ni llamadas externas. Este contrato está ignorado por docs/* y se incorpora con git add -f.

Checks finales: npm run typecheck correcto; eslint del módulo con --max-warnings=0 correcto; Jest public-api correcto (41 pruebas). La garantía de idempotencia de intención dura mientras se conserva api_jobs (90 días); callbacks pueden llegar fuera de orden y el receptor debe consultar el estado actual del job cuando necesite una decisión definitiva.


## Firebase management panel additions

All routes below use the Firebase ID token of the owning account. They never require
putting a newly revealed API key into browser storage.

- `GET /api/users/me/api-jobs?limit=25&cursor=<last UUID>`: `{items: Job[], nextCursor: string|null}`.
  Limit 1–100. Stable ascending document-ID order (not chronological); opaque continuation
  is an ID, cannot change account scope. `Job` is `{id,status,createdAt,updatedAt,attempts,errorCode:string|null,callbackId:string|null}`.
- `GET /api/users/me/api-usage`: `{pendingJobs,maxPendingJobs:20,retentionDays:90,observedAt}`.
  Pending capacity is operational queue usage; monthly conversion quota remains the existing user limits API.
- `GET /api/users/me/api-jobs/:id` and `GET .../:id/result`: same envelopes as API-key routes.
- `POST .../:id/cancel` and `POST .../:id/retry`: same state rules as API-key routes.
- `GET /api/users/me/api-callbacks/:id/deliveries`: `{items:[{id,jobId,state,attempts,lastErrorCode,createdAt,deliveredAt}]}`, maximum 100 records.
- `POST /api/users/me/api-callbacks/:id/deliveries/:deliveryId/retry`: 202 `{id,state:"pending"}`;
  requires owned active endpoint and a dead, unexpired delivery. Resets the bounded attempt budget
  while preserving payload/event identity for consumer deduplication. Pending/leased/delivered ->409,
  expired ->410, foreign/revoked ->404. No synchronous send in this request.


## Authenticated synthetic example check

POST `/api/v1/test`, Bearer API key with `jobs:write`, JSON `{ "fixtureId": "zpl-label-v1" }`, returns200 `{schemaVersion:1,mode:"test",status:"validated",execution:"authentication_and_schema_only",fixture:{id,zplContent,labelSize:"4x6"},quotaConsumed:0,usageCounted:false}`. This verifies the actual key, scope, account and feature access and returns a fixed synthetic example. It does **not** invoke the renderer, create a job, deliver callbacks or claim an end-to-end conversion. UI label: "Comprobar clave y obtener ejemplo"; clearly distinguish this from creating a regular job, which uses the existing quota. Keep an entered key in component memory only and clear it after use/unmount; never log it, put it in a URL or persist it in browser storage.


A full example conversion may be created through existing POST `/api/v1/jobs` with `testMode:true` (optional, defaultfalse). It follows the real queue, renderer, result and callback flow and **uses normal plan quota**. The persisted immutable marker appears in job responses and callback payloads, and its canonical success is `isSynthetic:true`, excluded from commercial adoption. Same idempotency key with a changed testMode conflicts. UI must distinguish this real test conversion from the free authentication/schema check. Test mode does not weaken permissions, scopes, rate limits, quota, input limits or callback protection.
