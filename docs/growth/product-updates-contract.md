# BE11 — Contrato del tour de novedades persistido

Ámbito: `src/modules/product-updates/**`. Sigue `tour-novedades-FE08.md` salvo su antigua
compuerta de construcción: el tour se construye ya para usuarios registrados, pero **la
presentación sigue dependiendo** de que exista un release aprobado en servidor y de que la
feature esté disponible según flags. Ninguna implementación técnica se anuncia como liberada.

## 1. Rutas

| Método | Ruta | Guard |
|---|---|---|
| GET | `/api/users/me/product-updates` | `FirebaseAuthGuard` |
| PATCH | `/api/users/me/product-updates/:releaseId/:tourVersion/progress` | `FirebaseAuthGuard` |

La identidad del progreso es `uid + releaseId + tourVersion`; el `uid` sale siempre del token,
nunca del path ni del body.

## 2. Fuente de verdad: config de release aprobada en servidor

Variable `PRODUCT_UPDATES_RELEASE` (JSON, un solo release, solo servidor). **Ausente o inválida =
sin release**: nada que anunciar. `enabled` ausente = `false` (deshabilitado por defecto). Publicar
varios releases simultáneos queda fuera de alcance: se presenta como máximo uno.

```json
{
  "releaseId": "growth-2026-09",
  "tourVersion": "1",
  "manifestVersion": "1",
  "enabled": true,
  "environment": "production",
  "releasedAt": "2026-09-18T00:00:00.000Z",
  "releasedFeatureIds": ["packing_workflow", "data_templates"],
  "steps": [
    { "stepId": "packing_overview", "featureId": "packing_workflow", "anchorId": "nav-packing", "order": 1 }
  ]
}
```

Validación (cualquier fallo invalida la config completa → `release_config_invalid`, sin release):

- Objeto JSON (no array, no null).
- `releaseId`, `tourVersion`, `manifestVersion`, `stepId`, `anchorId`: `^[a-z0-9][a-z0-9._-]{0,39}$`.
- `enabled`: booleano si está presente.
- `releasedAt`: ISO 8601 en **UTC explícito** (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`) y con calendario real.
  No se acepta `Date.parse` a secas: descarta strings ambiguos (sin zona, con offset, solo fecha) y
  fechas imposibles que el parser "corregiría" (`2026-02-31` rodaría a marzo y decidiría mal a quién
  se invita). Se normaliza a milisegundos.
- `releasedFeatureIds`: array no vacío, sin duplicados, todos en `FEATURE_IDS`.
- `steps`: array 1..12; `stepId` únicos; `order` entero finito y único; `featureId` presente en
  `releasedFeatureIds`.
- `environment`: obligatorio, de enum cerrado (`development` | `test` | `staging` | `production`), y
  debe coincidir con `PRODUCT_ENVIRONMENT ?? NODE_ENV ?? development`;
  si no coincide el release se descarta (`environment_mismatch`). Es lo que certifica despliegue
  probado **en ese entorno**: `released` de los flags es señal de rollout, no prueba de despliegue.

Release activo = config válida + `enabled` + entorno coincidente + `releasedAt <= now`.

**La config no transporta texto ni rutas.** Los textos son claves i18n derivadas de forma
determinista y el destino de navegación es un `routeKey` de un enum cerrado en código
(`CANONICAL_ROUTE_KEYS`), no una URL de la config: así una config manipulada no puede inyectar
copy ni destinos. Enum acordado con el frontend:

| `featureId` | `routeKey` |
|---|---|
| `packing_workflow` | `workflows` |
| `data_templates` | `templates` |
| `pdf_preparation` | `pdf` |
| `folder_automation` | `integrations` |
| `direct_print` | `printing` |
| `template_regression` | `regression` |
| `self_service_api` | `api` |
 Es la única desviación deliberada frente a la "ruta canónica" de FE08: el
frontend mapea `routeKey` a su propia ruta.

Claves: `productUpdates.<releaseId>.title` / `.summary`,
`productUpdates.<releaseId>.steps.<stepId>.title` / `.body`,
`productUpdates.upgrade.<featureId>.title` / `.body`.

## 3. Combinación config + flags (lo que se muestra)

Consumo de `FeatureFlagsService.getFeatures(uid)` (propiedad de root, no editado): `available`,
`eligible`, `entitled`, `released`, `minimumPlan`, `featureVersion`.

| Estado de la feature | Resultado en el manifiesto |
|---|---|
| En `releasedFeatureIds` y `available === true` | **paso accionable** (`action.kind = 'navigate'`, `routeKey`) |
| En `releasedFeatureIds`, `released === true` y `entitled === false` | **solo información honesta de upgrade** (`upgrades[]`, `minimumPlan`, sin `routeKey` ni navegación) |
| Cualquier otro caso: flag apagada, kill switch, variante control, plan fuera de `allowedPlans`, o feature fuera de `releasedFeatureIds` | **omitida** (no aparece ni como paso ni como upgrade) |

Un paso accionable **no** exige `released === true`: en piloto (`rolloutPercent < 100`) un usuario en
treatment tiene `available === true` y el release aprobado certifica la publicación en su entorno, así
que el paso se muestra. Lo que sí exige `released` es el aviso de upgrade, para no vender un plan que
todavía no daría acceso. Un plan con `entitled === true` pero `available === false` (kill switch,
control) se omite: no se anuncia algo que la cuenta no puede usar y tampoco se le ofrece pagar por
ello.

Un `upgrade` nunca lleva destino de navegación: no se enruta a un espacio de trabajo prohibido.
Los pasos accionables son **solo navegación explícita**: el contrato no expone ninguna acción que
convierta, imprima, conecte Drive, cree claves ni genere cargos.

## 4. GET — respuesta tipada

```ts
type PlanType = 'free' | 'lite' | 'pro' | 'promax' | 'enterprise';

interface ProductUpdatesResponse {
  schemaVersion: 1;
  plan: PlanType;
  /** Entrada permanente opcional ("Novedades"): siempre disponible para cualquier autenticado. */
  entry: { available: true; labelKey: 'productUpdates.entry' };
  release: ProductUpdatesRelease | null;
  invitation: { shouldInvite: boolean; reason: InvitationReason };
  progress: ProductTourProgress | null;
  /** Presente solo cuando `release === null`. */
  unavailableReason?: ReleaseUnavailableReason;
}

interface ProductUpdatesRelease {
  releaseId: string;
  tourVersion: string;
  manifestVersion: string;
  environment: string;
  releasedAt: string;          // ISO
  titleKey: string;
  summaryKey: string;
  steps: ProductTourStep[];    // 0..12, ordenados por `order`
  upgrades: UpgradeNotice[];   // 0..N, honestos, sin navegación
}

interface ProductTourStep {
  stepId: string;
  featureId: FeatureId;
  featureVersion: string;
  order: number;
  anchorId: string;
  titleKey: string;
  bodyKey: string;
  action: { kind: 'navigate'; routeKey: CanonicalRouteKey };
}

interface UpgradeNotice {
  featureId: FeatureId;
  featureVersion: string;
  minimumPlan: PlanType;
  titleKey: string;
  bodyKey: string;
  action: { kind: 'upgrade_info' };
}

interface ProductTourProgress {
  releaseId: string;
  tourVersion: string;
  state: TourState;            // 'pending' | 'started' | 'closed' | 'skipped' | 'completed'
  /** Terminal y monótono: lo fijan `skip`/`complete` y `replay` NO lo limpia. */
  invitationSuppressed: boolean;
  revision: number;            // CAS; 0 cuando aún no hay documento
  visitedStepIds: string[];    // unión, nunca se reduce
  lastStepId: string | null;   // cerrar conserva posición
  replays: number;
  startedAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  skippedAt: string | null;
  completedAt: string | null;
}

type InvitationReason =
  | 'registered_before_release'   // único caso con shouldInvite = true junto a 'resume_available'
  | 'resume_available'
  | 'invitation_suppressed'       // repitió tras omitir o completar: sin invitación automática
  | 'registered_after_release'
  | 'registration_unknown'
  | 'already_skipped'
  | 'already_completed'
  | 'no_release'
  | 'no_available_features'
  | 'progress_unavailable';

type ReleaseUnavailableReason =
  | 'no_release_configured'
  | 'release_config_invalid'
  | 'release_disabled'
  | 'release_not_yet_published'
  | 'environment_mismatch'
  | 'no_available_features';
```

`shouldInvite === true` exige **todo** esto: release activo, **`steps.length > 0` o
`upgrades.length > 0`** (Free y Lite tienen cero pasos y aun así pueden enterarse de lo ya
publicado: el resumen no promete acceso y el frontend lo distingue de la navegación por
`steps.length === 0`), progreso legible, `invitationSuppressed === false` y **registro anterior a
`releasedAt`** (`user.createdAt < releasedAt`).

Precedencia de `reason`: `progress_unavailable` → `already_skipped` → `already_completed` →
`invitation_suppressed` → `no_available_features` → `registration_unknown` →
`registered_after_release` → invita (`registered_before_release` en `pending`, `resume_available`
en `started`/`closed`, con `lastStepId` para retomar). `no_available_features` solo cuando pasos y
upgrades están **ambos** vacíos. Si `createdAt` falta o no es fecha válida no se invita. Nunca se
invita sin progreso confiable. La entrada permanente sigue disponible en todos estos casos:
`release` es lo que puede faltar, `entry` no.

Una versión nueva **no** fuerza apertura: `tourVersion` distinto crea un progreso propio en
`pending` y la invitación vuelve a depender de las mismas reglas. El idioma no interviene en el
progreso (solo claves i18n).

## 5. PATCH — cuerpo y respuestas

```ts
interface TourProgressBody {
  eventId: string;            // UUID v4, obligatorio: idempotencia
  expectedRevision: number;   // entero >= 0, obligatorio: CAS
  action: 'start' | 'view_step' | 'close' | 'skip' | 'complete' | 'replay';
  stepId?: string;            // obligatorio en 'view_step'; opcional en el resto
}

interface TourProgressResult {
  schemaVersion: 1;
  applied: boolean;           // false cuando fue duplicado o acción suprimida
  duplicate: boolean;         // true cuando ese eventId ya se había aplicado
  progress: ProductTourProgress;
}
```

- **Allowlist de `stepId`**: los `steps[].stepId` declarados en la **config aprobada** para ese
  `releaseId`+`tourVersion`, no el subconjunto filtrado por flags. Registrar que un paso se vio es
  contabilidad operativa y no concede acceso a nada; así un cambio de flag a mitad del tour no
  rompe el progreso ya empezado. `stepId` fuera de la allowlist → `400`.
- **Orden de comprobaciones**: (1) lápida/borrado de cuenta dentro de la transacción, (2) duplicado
  por `eventId` **más huella del cuerpo**, (3) CAS `expectedRevision`. El duplicado se resuelve
  **antes** del CAS para que un reintento cuya respuesta se perdió devuelva `200 { duplicate: true }`
  en vez de `409`.
- **Huella del cuerpo**: la ventana de idempotencia guarda `{ eventId, fingerprint }`, con
  `fingerprint = sha256(JSON.stringify([action, stepId ?? null, expectedRevision]))`. Mismo
  `eventId` con el mismo cuerpo ⇒ `200 duplicate`; mismo `eventId` con **otro** cuerpo ⇒ `409`
  `event_id_reused`, nunca un duplicado silencioso. Así un `replay` viejo reenviado con otra acción
  o con otra revisión esperada no puede mutar el progreso.
- **Monotonía**: rango `pending(0) < started(1) < closed(2) < skipped(3) < completed(4)`. Ninguna
  acción distinta de `replay` baja el rango; `skipped`/`completed` son terminales y suprimen
  invitaciones. `close` conserva `lastStepId`.
- **`view_step`** añade a `visitedStepIds` (unión) y fija `lastStepId` incluso en estado terminal,
  pero no rebaja el estado.
- **`replay`** es explícito: pasa el estado a `started`, incrementa `replays` y **apila** el estado
  terminal previo en `terminalHistory` (máx. 20 entradas, interno) sin borrarlo; `visitedStepIds` se
  conserva. **No** limpia `invitationSuppressed`: abrir sesión de nuevo no restablece la invitación
  automática, que solo se decide con esa bandera y no con el estado.
- **`skip` y `complete` fijan `invitationSuppressed = true`** de forma monótona; `close` no lo hace,
  porque cerrar conserva la posición para retomar.
- `start`, `close`, `skip`, `complete` y `replay` **no** requieren `stepId`: el resumen se puede
  operar sin abrir ningún paso. Solo `view_step` lo exige.
- Toda acción aceptada incrementa `revision` en 1 y registra `eventId` en una ventana de los 50
  últimos (crecimiento acotado del documento). Un duplicado más antiguo que la ventana chocará en
  el CAS, que es la respuesta segura.

`applied` es `false` cuando la acción quedó suprimida por monotonía (por ejemplo `close` sobre un
tour ya completado): el `eventId` se consume y `revision` avanza igual, porque la contabilidad de
idempotencia es lo que hace seguro el reintento.

Códigos: `200` aplicado o duplicado; `400` cuerpo inválido, acción desconocida, `view_step` sin
`stepId` o `stepId` fuera de allowlist (`tour_step_required`, `tour_step_unknown`); `401` sin token,
token inválido o cuenta marcada para borrado; `404` `release_not_available` (release o versión no
existen en la config aprobada, o release deshabilitado); `409` `revision_conflict` (CAS) o
`event_id_reused` (mismo `eventId`, otro cuerpo), ambos con la revisión y el progreso reales para
que el cliente resincronice.

Los errores salen por el `HttpExceptionFilter` global, así que el cuerpo es el estándar del
proyecto:

```json
{
  "success": false,
  "error": "revision_conflict",
  "message": "Stored tour progress has a different revision",
  "data": { "currentRevision": 3, "progress": { "state": "started", "revision": 3 } },
  "requestId": "..."
}
```

## 6. Persistencia

Colección `product_tour_progress`, id `sha256(JSON.stringify([uid, releaseId, tourVersion]))` en
hex. Hash y no concatenación: un uid puede traer barras o los mismos separadores y dos identidades
distintas no pueden acabar en el mismo documento. El id además no revela la cuenta; `accountId`
sigue como campo porque el borrado por cuenta consulta por campo, no por prefijo de id.

```ts
{
  schemaVersion: 1,
  accountId: string,          // top-level, requerido: limpieza por borrado de cuenta
  releaseId: string,
  tourVersion: string,
  state: TourState,
  invitationSuppressed: boolean,
  revision: number,
  visitedStepIds: string[],
  lastStepId: string | null,
  replays: number,
  terminalHistory: { state: TourState; at: string }[],
  appliedEvents: { eventId: string; fingerprint: string }[],  // ventana de 50
  startedAt, updatedAt, closedAt, skippedAt, completedAt  // ISO o null
}
```

Aislamiento por cuenta: el id del documento incluye el `uid` del token y toda lectura filtra por
él; ninguna ruta acepta un `uid` ajeno. **Sin TTL**: `skipped`/`completed` deben suprimir
invitaciones indefinidamente, así que el borrado es por cuenta, no por vencimiento.

Contenido: ninguno de estos campos admite texto libre, contenido de etiquetas ni secretos. La
preferencia operativa del tour es independiente del consentimiento analítico: este backend no
emite eventos de analítica ni los exige para persistir progreso.

## 7. Interfaz con código compartido (propiedad de root)

1. **Limpieza por borrado de cuenta**: una sola colección, `product_tour_progress`, con `accountId`
   top-level. No hay outbox ni colección de idempotencia aparte: los `eventId` viven dentro del
   mismo documento de progreso. Sin TTL ciego: el borrado es por cuenta.
2. **Enum de analítica** (root): los eventos los emite el frontend vía FE00; este módulo no emite
   ninguno ni exige consentimiento analítico para persistir progreso. Nombres:
   `tour_invitation_viewed`, `tour_started`, `tour_step_viewed`, `tour_dismissed`, `tour_completed`,
   `tour_feature_opened` y `tour_upgrade_clicked` (añadido por root), con `surface = 'tour'` y
   metadatos opcionales `releaseId`, `tourVersion`, `tourStepId`, ya presentes en
   `observability.types.ts`. Apertura o completado **no** son activación ni pago y quedan fuera de las métricas
   canónicas de activación/feedback.
3. **Helper de validación sin import circular**: `release-config.ts` es una hoja que solo importa
   `observability.types.js` (constantes) y `user.interface.js` (tipos). Root puede importar desde
   analítica sin ciclo:
   - `parseProductUpdatesRelease(raw: string | undefined): ReleaseConfigResult`
   - `loadApprovedRelease({ raw, environment, now }): ReleaseConfigResult` — aplica además
     aprobación explícita, entorno y `releasedAt`.
   - `isKnownTourMetadata(release, { releaseId, tourVersion, stepId })` — valida los metadatos
     opcionales del evento contra la config aprobada, para descartar valores inventados por el
     cliente sin acoplar analítica a mi servicio. Con `release = null` devuelve `false`: sin
     release aprobado ningún identificador de tour es conocido.

   `ReleaseConfigResult` **no** es una unión discriminada:

   ```ts
   interface ReleaseConfigResult {
     ok: boolean;
     release: ProductUpdatesRelease | null;  // null cuando ok === false
     reason: ReleaseUnavailableReason | null; // null cuando ok === true
   }
   ```

   Motivo verificado con `tsc`: el repo compila con `strictNullChecks: false` y en ese modo
   TypeScript no estrecha uniones por un discriminante booleano, así que
   `result.ok ? result.release : null` —tal como lo usa `product-observability.service.ts`— no
   compilaría contra `{ ok: true; release } | { ok: false; reason }`.
4. Consumo confirmado de `getFeatures()`: uso `available`, `eligible`, `entitled`, `released`,
   `minimumPlan`, `featureVersion`. No edito `feature-flags.service.ts` ni `feature-entitlements.ts`.
   Si cambia la definición de `released`, cambia con ella la fila "solo upgrade" de §3.
5. `registered_before_release` usa `getUserById().createdAt`, que puede volver como `Date`
   (Timestamp convertido) o como string ISO en cuentas antiguas: acepto ambos y trato cualquier otro
   valor como desconocido (`registration_unknown`, sin invitación).

## 8. Catálogo público para precios

`GET /api/product-updates/catalog` no requiere sesión. Devuelve HTTP 200 y
`Cache-Control: no-store` con:

```ts
interface PublicProductCatalog {
  schemaVersion: 1;
  releaseId: string | null;
  manifestVersion: string | null;
  features: { featureId: FeatureId; minimumPlan: PlanType }[];
}
```

Reutiliza `loadApprovedRelease` y la misma validación de flags y condición global
que `FeatureFlagsService.released`: enabled, sin kill switch, rollout al 100%,
`pilotAccountIds` ausente (incluso `[]` restringe), y `allowedPlans` incluyendo
TODOS los planes con entitlement. Intersecta con `releasedFeatureIds`; no exige
que la función tenga un paso en el tour. Los planes mínimos proceden de
`FEATURE_MINIMUM_PLANS`. El cliente aplica la jerarquía de planes para mostrar
las funciones heredadas, sin interpretar el catálogo como autorización de cuenta.

Release ausente/inválido/apagado/futuro/de otro entorno, flags inválidas o ninguna
función publicable: `{schemaVersion:1,releaseId:null,manifestVersion:null,features:[]}`.
Una flag individual válida pero no global se omite; las demás pueden aparecer.
La lectura no consulta cuentas, progreso, conexiones ni asignaciones, no crea
cuentas sintéticas y no escribe Firestore. No incluye IDs privados, credenciales,
claims, información de experimentos ni datos del tour. Las rutas autenticadas
conservan sus guards y siguen siendo la autoridad para acceso individual.
