# BE04 · BE05 — contrato de API: lotes (`workflows`) y plantillas (`label-templates`)

Estado: implementado en los módulos `src/modules/workflows/**` y `src/modules/label-templates/**`; **no integrado en `AppModule`, no desplegado y con los flags apagados**. Los adaptadores reales (flags, eventos, lector XLSX) se registran dentro de los propios módulos: al coordinador solo le queda el import en `AppModule`, los índices y el TTL. Este documento es el contrato para FE01 y FE02; los nombres de tipo coinciden con los DTO reales.

Prefijo global `/api`. Autenticación `FirebaseAuthGuard` (`Authorization: Bearer <idToken>`) en todos los endpoints. Todos los timestamps son ISO-8601 UTC (`2026-09-17T12:00:00.000Z`); la agregación por día es asunto de BE03, no de estos endpoints.

## 0. Reglas transversales

- **Propiedad en cada operación.** Cada lectura y escritura comprueba `ownerId === uid`. Un recurso ajeno o inexistente devuelve el mismo `404 WORKFLOW_NOT_FOUND` / `404 TEMPLATE_NOT_FOUND`: no se distingue para no confirmar ids de terceros. `accountId` ya viaja en las entidades e hoy vale `uid` (preparado para equipos, sin multiusuario).
- **Flag y disponibilidad.** `packing_workflow` (BE04) y `data_templates` (BE05) se consultan por el puerto `FEATURE_GATE` antes de cualquier ingreso nuevo. **Sin adaptador registrado el módulo deniega**: `403 FEATURE_NOT_AVAILABLE`. Apagar el flag no borra lotes, plantillas ni exportaciones ya creadas; la lectura y la descarga de lo existente siguen permitidas.
- **CAS (`version`).** El lote y la plantilla llevan `version: number` (entero, empieza en 1). Toda mutación exige `expectedVersion`. Si no coincide: `409 WORKFLOW_VERSION_CONFLICT` / `409 TEMPLATE_VERSION_CONFLICT` con `data.currentVersion` y `data.expectedVersion`. Nunca se sobrescribe la edición de otro.
- **Idempotencia por intención.** Exportar (lote) y ejecutar (plantilla) exigen la cabecera `Idempotency-Key` (1–200 caracteres). El identificador de la operación se deriva de `accountId` + `Idempotency-Key`, y el `intentHash` guardado cubre **el contenido exacto que se va a producir** (lote y versión, formato, reimpresión-de; o versión de plantilla, filas normalizadas y checksum del archivo). Repetir la misma petición devuelve `200` con la misma operación y el mismo `jobId`, sin consumir cuota otra vez. La misma clave con distinta intención devuelve `409 IDEMPOTENCY_KEY_REUSED`. Una petición concurrente con la misma intención mientras la primera está en vuelo devuelve `409 EXPORT_IN_PROGRESS` / `409 RUN_IN_PROGRESS`.
- **Identificadores.** `workflowId`, `exportId`, `runId`, `reconcileId` y `jobId` son UUIDv4. Los de operación son **deterministas**: se derivan de la cuenta y de la `Idempotency-Key` (o de plantilla + versión) y se les colocan los bits de versión y variante del formato, porque el puente de conversión y el registro de eventos validan UUIDv4 y la idempotencia exige que el mismo reintento produzca el mismo id. No son aleatorios y no pretenden serlo.
- **Cuota y conversión.** Exportar y ejecutar pasan por `ZplService.runDurableConversion({ operationId, userId, zplContent, labelSize, outputFormat?, originalFilename? })`: espera a que la conversión **termine**, reserva la cuota de forma atómica y es idempotente por `operationId`. El `operationId` es el propio `exportId`/`runId`, así que `jobId === exportId` (o `runId`) y un reintento no produce una segunda conversión ni un segundo cargo. Los reintentos idempotentes, `inspect`, `validate`, el cotejo y los eventos no consumen cuota. Estos módulos no leen ni escriben contadores de facturación por su cuenta.
- **Límites del servidor.** Los decide el servidor a partir del plan (`DEFAULT_PLAN_LIMITS`) y de topes absolutos; el cliente no los envía. Ver §3.
- **Retención.** El ZPL de origen de un lote caduca a los **15 días** (`sourceExpiresAt`, y `expiresAt` como `Timestamp` nativo para TTL). Las plantillas y sus versiones **no caducan** mientras la cuenta las conserve. El archivo CSV/XLSX subido **no se almacena**: solo su `checksum`, número de filas y el mapeo. Habilitar TTL y el barrido por eliminación de cuenta queda fuera de este cambio.
- **Errores.** Forma `{ error: <CODE>, message: string, data?: object }`, igual que el resto de la API. Los diagnósticos por fila viajan en `data.rows`.
- **Cuenta dada de baja.** Cualquier escritura sobre una cuenta con lápida en `deleted_accounts` devuelve `410 ACCOUNT_DELETED`. La comprobación va dentro de la propia transacción de negocio (§4.3).

## 1. BE04 — lotes (`/workflows`)

### Estados

| Campo | Valores | Significado |
|---|---|---|
| `workflow.status` | `draft` · `ready` · `archived` | `ready` en cuanto tiene al menos una exportación aceptada. `archived` es baja lógica; conserva las exportaciones. |
| `export.status` | `accepted` · `failed` | `accepted` = el conversor admitió el trabajo y devolvió `jobId`. **No** significa PDF terminado: el progreso se sigue con `GET /zpl/status/:jobId`, y descargar con `GET /zpl/download/:jobId` (rutas existentes, sin cambios). |
| `label.reconcileStatus` | `matched` · `duplicate` · `unidentified` · `extra` | Solo presente tras un cotejo. Ver §1.7. |
| fila del CSV de cotejo | `matched` · `missing` · `duplicate` | Estado de la fila, no de la etiqueta. |

### Tipos

```ts
type WorkflowStatus = 'draft' | 'ready' | 'archived';
type ReconcileLabelStatus = 'matched' | 'duplicate' | 'unidentified' | 'extra';
type ReconcileRowStatus  = 'matched' | 'missing' | 'duplicate';
type ReconcileFormat = 'pedido_id_guia_v1' | 'order_id_tracking_v1';

interface LabelRef {            // una etiqueta del lote
  labelId: string;              // estable: no cambia al reordenar ni al reexportar
  groupId: string;              // mismo contenido ⇒ mismo groupId (selección por grupo)
  sequence: number;             // posición original 1..N, inmutable
  order: number;                // posición actual 1..N, editable
  copies: number;               // copias que se imprimirán: el override, o las de ^PQ
  originalCopies: number;       // lo que declaró ^PQ; nunca se pierde
  copiesOverridden: boolean;
  serialized: boolean;          // usa ^SN/^SF: no admite cambiar copias
  selected: boolean;
  contentHash: string;          // sha256 del ZPL normalizado sin ^PQ
  byteSize: number;
  fields: Record<string, string>; // valores ^FD legibles, con la clave fdN; no se inventan campos
  reconcileStatus?: ReconcileLabelStatus;
  reconcileOrderId?: string;    // solo si una fila del CSV lo aportó
  reconcileTracking?: string;
}

interface WorkflowSourceRef {
  kind: 'inline_zpl' | 'history';
  historyId?: string;           // origen = historial (reconvertir sin volver a subir)
  originalFilename?: string;
  sha256: string;
  byteSize: number;
}

interface WorkflowJobRef {
  exportId: string;
  jobId: string;                // job del conversor existente
  createdAt: string;
  labelCount: number;           // etiquetas incluidas, contando copias
  reexportOf?: string;          // exportId anterior (reimpresión ligada al original)
}

interface LabelWorkflow {
  id: string;
  accountId: string;
  featureId: 'packing_workflow';
  featureVersion: string;       // '1'
  status: WorkflowStatus;
  name?: string;
  labelSize: string;            // '4x6' | '2x1' | '2x4' | '4x2' | '50x80mm' | '80x50mm'
  outputFormat: 'pdf' | 'png' | 'jpeg';
  version: number;              // CAS
  totalLabels: number;          // etiquetas distintas (bloques ^XA..^XZ)
  totalCopies: number;          // suma de copies
  selectedCount: number;
  selectedCopies: number;
  sourceRefs: WorkflowSourceRef[];
  jobRefs: WorkflowJobRef[];
  reconcile?: ReconcileSummary;
  createdAt: string;
  updatedAt: string;
  sourceExpiresAt: string;      // createdAt + 15 días
  labels?: LabelRef[];          // presente en GET /workflows/:id, ya ordenado
}

interface ReconcileSummary {
  reconcileId: string;
  format: ReconcileFormat;
  completedAt: string;
  rowCount: number;
  counts: { matched: number; duplicate: number; unidentified: number; extra: number; missing: number };
  missingRows: { rowNumber: number; orderId: string; tracking?: string }[];
  duplicateRows: { rowNumber: number; orderId: string; labelIds: string[] }[];
}
```

### 1.1 `POST /workflows`

```ts
interface CreateWorkflowDto {
  zplContent?: string;          // exclusivo con historyId
  historyId?: string;           // reconvertir desde el historial, sin volver a subir
  labelSize: string;
  outputFormat?: 'pdf' | 'png' | 'jpeg';   // default 'pdf'
  name?: string;                // ≤ 120 caracteres
  originalFilename?: string;
}
```

`201` → `LabelWorkflow` con `labels`. El orden inicial es el de aparición en el ZPL; todas las etiquetas quedan `selected: true`. Las copias `^PQ` se conservan: **no se deduplican** bloques idénticos (dos bloques iguales son dos etiquetas con el mismo `groupId`).

Con `historyId` se reutiliza la recuperación del original que ya existe, con su control de acceso: requiere la capacidad de historial del plan (Pro y superiores) y respeta su retención de 15 días.

Errores: `400 INVALID_ZPL` (sin bloques `^XA..^XZ`), `400 INVALID_LABEL_SIZE`, `400 INVALID_INPUT` (ambos orígenes o ninguno), `403 FEATURE_NOT_AVAILABLE`, `403 WORKFLOW_LABEL_LIMIT_EXCEEDED` (`data.limit`, `data.actual`), `413 WORKFLOW_SOURCE_TOO_LARGE`, `403 WORKFLOW_QUOTA_EXCEEDED` (demasiados lotes activos), `404 HISTORY_NOT_FOUND`, `410 ZPL_NOT_AVAILABLE` (el original ya expiró).

### 1.2 `GET /workflows` · `GET /workflows/:id`

- `GET /workflows?limit=&cursor=&status=` → `{ items: LabelWorkflow[] (sin labels), nextCursor?: string }`, más recientes primero.
- `GET /workflows/:id` → `LabelWorkflow` con `labels` ordenadas por `order`.

### 1.3 `PATCH /workflows/:id/order`

```ts
interface UpdateOrderDto {
  expectedVersion: number;
  labelIds: string[];           // permutación COMPLETA; misma cantidad y mismos ids
}
```

`200` → `LabelWorkflow`. Se rechaza cualquier alta, baja o repetición de ids (`400 WORKFLOW_ORDER_MISMATCH`, con `data.missing` y `data.unknown`). Las copias no se tocan: reordenar nunca cambia `copies`.

### 1.4 `PATCH /workflows/:id/selection`

```ts
interface UpdateSelectionDto {
  expectedVersion: number;
  mode: 'replace' | 'select' | 'deselect';
  labelIds?: string[];
  groupIds?: string[];          // selecciona/deselecciona el grupo de copias completo
}
```

`200` → `LabelWorkflow`. `400 WORKFLOW_SELECTION_EMPTY` si `replace` dejaría el lote sin etiquetas seleccionadas.

### 1.5 `PATCH /workflows/:id/copies`

```ts
interface UpdateCopiesDto {
  expectedVersion: number;
  items: { labelId: string; copies: number }[];  // copies 1..999
}
```

`200` → `LabelWorkflow`. Fija a mano las copias de etiquetas concretas; poner de nuevo el valor de `^PQ` retira el override, y `originalCopies` nunca cambia.

**Una etiqueta serializada (`^SN`/`^SF`) se rechaza**: la impresora genera un valor distinto en cada copia, así que cambiar el número de copias alteraría la serie impresa. El frontend puede desactivar el control por adelantado mirando `label.serialized`, pero el servidor lo vuelve a comprobar: `422 WORKFLOW_SERIALIZED_LABEL` con `data.labelIds`.

Otros errores: `409 WORKFLOW_VERSION_CONFLICT`, `400 WORKFLOW_ORDER_MISMATCH` (etiqueta ajena al lote), `400 WORKFLOW_COPIES_LIMIT_EXCEEDED` (fuera de 1..999), `403 WORKFLOW_LABEL_LIMIT_EXCEEDED` si con esas copias el lote supera el tope del plan.

### 1.6 `POST /workflows/:id/exports`

Cabecera obligatoria `Idempotency-Key`.

```ts
interface CreateExportDto {
  expectedVersion: number;      // exporta el orden/selección de esa versión
  reexportOf?: string;          // exportId previo: liga la reimpresión al job original
  outputFormat?: 'pdf' | 'png' | 'jpeg';  // default: el del lote
}

interface WorkflowExport {
  exportId: string;
  workflowId: string;
  status: 'accepted' | 'failed';
  jobId?: string;
  reexportOf?: string;
  workflowVersion: number;
  labelCount: number;           // contando copias
  uniqueLabelCount: number;
  labelIds: string[];           // orden exacto exportado
  intentHash: string;
  idempotent: boolean;          // true ⇒ respuesta reutilizada, sin nuevo consumo
  createdAt: string;
  errorCode?: string;
}
```

`201` la primera vez, `200` en la repetición idempotente. El seguimiento y la descarga usan las rutas existentes de `/zpl`. `PNG`/`JPEG` solo si el plan tiene `canDownloadImages` (`403 IMAGE_FORMAT_PRO_ONLY`, lo decide el conversor). Otros errores: `409 WORKFLOW_VERSION_CONFLICT`, `409 IDEMPOTENCY_KEY_REUSED`, `409 EXPORT_IN_PROGRESS`, `400 WORKFLOW_SELECTION_EMPTY`, `403 MONTHLY_LIMIT_EXCEEDED` / `400 LABEL_LIMIT_EXCEEDED` (del conversor), `404 EXPORT_NOT_FOUND` (si `reexportOf` no es del lote), `410 WORKFLOW_SOURCE_EXPIRED`.

`GET /workflows/:id/exports` → `{ items: WorkflowExport[] }`.

### 1.7 `POST /workflows/:id/reconcile`

```ts
interface ReconcileDto {
  expectedVersion: number;
  format: ReconcileFormat;      // explícito: no se adivina
  csvContent: string;           // texto del CSV (≤ 2 MB, ≤ 5000 filas)
  delimiter?: ',' | ';' | '\t'; // si falta, se infiere solo cuando es inequívoco
}
```

Los dos formatos aceptados son exactamente:

| `format` | Dos primeras columnas exigidas |
|---|---|
| `pedido_id_guia_v1` | `pedido_id,guia` (`guia` puede ir vacía) |
| `order_id_tracking_v1` | `order_id,tracking` |

Las dos primeras columnas deben llamarse exactamente así (sin distinguir mayúsculas); las columnas adicionales se ignoran y se devuelven en `ignoredColumns`.

`200` → `{ workflow: LabelWorkflow, reconcile: ReconcileSummary, ignoredColumns: string[] }`. Reglas:

- Una etiqueta se identifica por sus valores `^FD` normalizados (recorte de espacios, comparación sin distinguir mayúsculas). Si alguno coincide con `pedido_id`/`order_id` o con `guia`/`tracking` de una fila, la etiqueta queda ligada a esa fila.
- `matched`: primera etiqueta que liga con la fila. `duplicate`: otra etiqueta liga con una fila ya ligada — **se marca, nunca se borra**. Las copias `^PQ` de una etiqueta no son repeticiones: una etiqueta con `copies: 3` es un solo `matched`.
- `unidentified`: la etiqueta no tiene ningún valor `^FD` legible del que partir.
- `extra` (sobrante): la etiqueta tiene valores legibles pero ninguno aparece en el CSV.
- `missing` (faltante): fila del CSV sin ninguna etiqueta.
- El cotejo **no** modifica el orden, la selección ni las copias, y no borra nada. Es reversible repitiéndolo con otro archivo.
- Las etiquetas se recorren por su posición original (`sequence`), no por el orden actual: reordenar el lote no cambia quién queda `matched` y quién `duplicate`.
- Un `pedido_id` repetido **dentro del CSV** es un error del archivo (`ROW_DUPLICATE_KEY`), no un `duplicate` de etiqueta.

Errores: `400 RECONCILE_HEADER_MISMATCH` (`data.expected`, `data.found`), `400 RECONCILE_AMBIGUOUS_DELIMITER`, `400 RECONCILE_EMPTY`, `413 RECONCILE_TOO_LARGE`, `422 RECONCILE_ROW_ERRORS` con `data.rows: { rowNumber, column, code, message }[]` (fila 1 = primera fila de datos; la cabecera es la línea 1 del archivo).

### 1.8 `POST /workflows/:id/archive` · `DELETE /workflows/:id`

`archive` marca `archived` (CAS, cuerpo `{ expectedVersion }`) y devuelve el lote. `DELETE` responde `204` y borra el lote y sus etiquetas; las exportaciones se conservan como registro (`workflowDeleted: true`) para no perder la traza de lo ya cobrado.

## 2. BE05 — plantillas y datos (`/label-templates`, `/template-runs`)

### Estados

| Campo | Valores |
|---|---|
| `template.status` | `active` · `archived` |
| versión | inmutable: se crea y no se modifica nunca. Una ejecución fija `templateVersion`. |
| `run.status` | `validated` (solo `validate`) · `accepted` · `failed` |
| fila | `valid` · `invalid` · `empty` |

### Tipos

```ts
type TemplateKind = 'product' | 'location' | 'lot';
type TemplateFieldType = 'text' | 'code' | 'integer' | 'decimal' | 'date' | 'barcode';
type TemplateFieldCharset = 'digits' | 'alnum' | 'alnum_dash' | 'any';
type TabularFormat = 'csv' | 'xlsx';

interface TemplateField {
  key: string;                  // ^[a-z][a-z0-9_]{0,39}$
  label: string;
  type: TemplateFieldType;      // 'code' = identificador textual: preserva ceros iniciales
  required: boolean;
  maxLength?: number;
  charset?: TemplateFieldCharset;
  barcodeSymbology?: 'code128' | 'code39' | 'ean13' | 'upca' | 'qr' | 'datamatrix';
}

interface ColumnMapping {
  // clave de campo -> nombre de columna del archivo
  fields: Record<string, string>;
  // columna con la cantidad de copias; si falta, 1 copia por fila
  quantityColumn?: string;
}

interface LabelTemplate {
  id: string;
  accountId: string;
  kind: TemplateKind;
  name: string;
  status: 'active' | 'archived';
  currentVersion: number;       // número de versión vigente
  version: number;              // CAS de la metadata
  savedMapping?: ColumnMapping; // se reutiliza al subir otro archivo
  createdAt: string;
  updatedAt: string;
}

interface TemplateVersion {     // INMUTABLE
  id: string;                   // `${templateId}:${versionNumber}`
  templateId: string;
  versionNumber: number;
  labelSize: string;
  fields: TemplateField[];
  zplTemplate: string;          // ^XA…^XZ con marcadores ^FD{{clave}}^FS
  checksum: string;
  createdAt: string;
}

interface RowDiagnostic {
  rowNumber: number;            // 1 = primera fila de datos
  column?: string;
  field?: string;
  code: string;                 // ver tabla de códigos
  message: string;
}

interface TemplateRun {
  runId: string;
  templateId: string;
  templateVersion: number;
  status: 'validated' | 'accepted' | 'failed';
  jobId?: string;
  format: TabularFormat;
  labelSize: string;
  outputFormat: 'pdf' | 'png' | 'jpeg';
  rowCount: number;             // filas de datos leídas
  validRowCount: number;
  emptyRowCount: number;
  invalidRowCount: number;
  labelCount: number;           // etiquetas con copias
  diagnostics: RowDiagnostic[];
  previewZpl?: string[];        // solo en validate: primeras filas renderizadas
  sourceChecksum: string;       // sha256 del archivo; el archivo NO se guarda
  intentHash: string;
  idempotent: boolean;
  createdAt: string;
  errorCode?: string;
}
```

### 2.1 Plantillas

- `GET /label-templates/builtin` → las tres definiciones iniciales (`product`, `location`, `lot`) con sus campos y su ZPL. No requiere plantilla creada.
- `POST /label-templates` → `{ fromBuiltin: TemplateKind, name?: string }` **o** `{ kind, name, labelSize, fields, zplTemplate }`. Crea la plantilla y su **versión 1**. `201` → `{ template: LabelTemplate, version: TemplateVersion }`.
- `GET /label-templates` → `{ items: LabelTemplate[] }`. `GET /label-templates/:id` → `{ template, versions: TemplateVersion[] }`.
- `POST /label-templates/:id/versions` → `{ expectedVersion, labelSize?, fields, zplTemplate }`. Crea `currentVersion + 1`. **Las ejecuciones anteriores no cambian**: apuntan a su número de versión.
- `PATCH /label-templates/:id` → `{ expectedVersion, name?, savedMapping?, status? }`. No toca campos ni ZPL: eso siempre es una versión nueva.
- `DELETE /label-templates/:id` → archiva (no borra versiones: una ejecución pasada debe seguir siendo explicable).

Validación del ZPL de plantilla (`422 TEMPLATE_ZPL_INVALID`, con `data.reasons`): debe empezar por `^XA` y acabar en `^XZ`; cada marcador debe aparecer **exactamente** como `^FD{{clave}}^FS`; toda clave usada debe estar declarada en `fields` y toda clave declarada debe usarse; no se admite `{{` fuera de esa forma, ni `^FH` propio, ni comandos de control `~` en el cuerpo, ni tamaño > 16 KB.

### 2.2 Escapado de ZPL (inyección)

El renderizador nunca interpola el valor en crudo. Sustituye el marcador completo por `^FH_^FD<valor codificado>^FS`, y codifica en hexadecimal `_XX` **todo** byte que no sea ASCII imprimible seguro: `^`, `~`, `_`, `\`, comillas, los bytes < 0x20 y ≥ 0x7F (los acentos viajan como sus bytes UTF-8 con `^CI28`). Un valor con `^XZ^XA` o `~JA` acaba como texto literal dentro del campo: no puede abrir un comando. Los caracteres de control en la entrada se rechazan antes (`ROW_CONTROL_CHAR`), no se silencian.

### 2.3 `POST /template-runs/inspect`

Mira la forma del archivo **antes** de pedirle al operador que asigne columnas. Mismo cuerpo que `validate`, con `templateId` opcional (si se envía, propone el mapeo). No convierte, no consume cuota y no guarda el archivo.

```ts
interface InspectTableResult {
  format: TabularFormat;
  sheet?: string;                 // hoja leída (xlsx)
  availableSheets?: string[];     // todas las hojas del libro, en orden
  rowCount: number;               // filas de datos, vacías incluidas
  emptyRowCount: number;
  columns: {
    index: number;
    name: string;                 // col1..colN si hasHeader es false
    kinds: ('empty'|'string'|'number'|'boolean'|'date'|'formula'|'error')[];
    nonEmptyCount: number;
    sampleValues: string[];       // recortados a 120 caracteres
  }[];
  sampleRows: { rowNumber: number; values: string[] }[];
  suggestedMapping?: ColumnMapping;   // solo con templateId
}
```

`kinds` es la señal que el asistente necesita: una columna de identificadores con `number` significa que el XLSX ya perdió los ceros iniciales, y el mapeo la rechazará por ambigua. Los valores de muestra son datos operativos de la propia cuenta: se devuelven al dueño y **no** salen hacia analítica ni se guardan con la ejecución.

### 2.4 `POST /template-runs/validate`

```ts
interface ValidateRunDto {
  templateId: string;
  templateVersion?: number;     // default: currentVersion
  format: TabularFormat;
  content: string;              // csv: texto | xlsx: base64
  delimiter?: ',' | ';' | '\t';
  decimalSeparator?: '.' | ',';
  sheet?: string | number;      // solo xlsx
  hasHeader?: boolean;          // default true
  mapping?: ColumnMapping;      // si falta: savedMapping, y si no, coincidencia exacta por nombre de columna
  previewRows?: number;         // 1..5, default 3
}
```

`200` → `{ run, mapping, sheet?, availableSheets? }`. El `run` llega con `status: 'validated'`, `diagnostics`, `previewZpl` y `previewFields`:

```ts
previewFields: { rowNumber: number; copies: number; values: Record<string, string> }[];
```

`previewFields` son los valores **literales ya validados** de las primeras filas, para poder mostrar lo que se va a imprimir y no solo el ZPL. Igual que en `inspect`: datos operativos del dueño, nunca analítica. No consume cuota y no crea trabajo; `mapping` viene resuelto para que el frontend lo guarde.

### 2.5 `POST /template-runs`

Cabecera obligatoria `Idempotency-Key`. Cuerpo: `ValidateRunDto` más:

```ts
{
  outputFormat?: 'pdf' | 'png' | 'jpeg';   // default 'pdf'
  onInvalidRows?: 'reject' | 'skip';       // default 'reject'
  saveMapping?: boolean;                   // default true
}
```

`201` (o `200` idempotente) → `TemplateRun` con `status: 'accepted'` y `jobId`. Con `onInvalidRows: 'reject'` y al menos una fila inválida: `422 TEMPLATE_ROW_ERRORS` y `data.rows`, sin crear trabajo ni consumir cuota. Con `'skip'`, las filas inválidas quedan en `diagnostics` y no producen etiqueta.

`GET /template-runs?templateId=` → `{ items: TemplateRun[] }`; `GET /template-runs/:runId` → `TemplateRun`.

### 2.6 Reglas de datos

- **Ceros iniciales.** Los campos `code` (y `text`) no se convierten a número nunca. CSV: el valor se toma literal (`"007"` → `007`). XLSX: una celda **numérica** mapeada a `code` es ambigua y se rechaza (`ROW_AMBIGUOUS_LEADING_ZERO`), porque el `0` perdido no es recuperable; hay que formatearla como texto.
- **Acentos.** Se conserva el texto tal cual (UTF-8, `^CI28`); se elimina el BOM inicial.
- **Separadores regionales.** `delimiter` explícito; si falta, se infiere de la cabecera **solo** cuando un único candidato produce más de una columna, y si no: `400 AMBIGUOUS_DELIMITER`. Para `decimal`, `decimalSeparator` explícito; un valor como `1,234` que pueda leerse como millar o decimal se rechaza (`ROW_AMBIGUOUS_NUMBER`).
- **Filas vacías.** No producen etiqueta, no son error y se informan (`emptyRowCount` + un diagnóstico `ROW_EMPTY` con su número de fila) para que se vea que se saltaron.
- **Cantidad.** `quantityColumn` debe ser entero ≥ 1 y ≤ 999 por fila; se emite `^PQ<n>` cuando es > 1. Vacía ⇒ 1. `0`, decimales o negativos: `ROW_INVALID_QUANTITY`.
- **XLSX.** Sin fórmulas: una celda con fórmula se rechaza (`ROW_FORMULA_NOT_ALLOWED`) y **no se evalúa** — el resultado que el archivo trae cacheado se descarta, no se lee. Una celda con error de la hoja → `ROW_CELL_ERROR`. Sin macros: una entrada `vbaProject.bin` en el ZIP → `422 XLSX_MACROS_NOT_ALLOWED`. Límites: ≤ 5 MB de entrada, ≤ 64 MB ya descomprimido, ≤ 512 entradas en el ZIP, ≤ 5000 filas, ≤ 64 columnas, celdas ≤ 4 KB y una sola hoja por ejecución (`sheet` por nombre o por posición, 1 = la primera). Un libro con tamaños ZIP64 se rechaza (`DATA_INVALID`). Las filas en blanco que la hoja se salta se detectan por el hueco en la numeración y se informan como `ROW_EMPTY`. Si el lector XLSX no está registrado en el despliegue: `422 FEATURE_UNSUPPORTED` con `data.feature: 'xlsx'` — nunca una salida inventada.

### 2.7 Códigos de diagnóstico por fila

`ROW_EMPTY` · `ROW_REQUIRED_MISSING` · `ROW_TOO_LONG` · `ROW_CHARSET` · `ROW_CONTROL_CHAR` · `ROW_INVALID_INTEGER` · `ROW_INVALID_DECIMAL` · `ROW_AMBIGUOUS_NUMBER` · `ROW_AMBIGUOUS_LEADING_ZERO` · `ROW_INVALID_DATE` · `ROW_INVALID_QUANTITY` · `ROW_FORMULA_NOT_ALLOWED` · `ROW_CELL_ERROR` · `ROW_CELL_TOO_LARGE` · `ROW_COLUMN_MISSING`.

Una columna mapeada que no existe en el archivo **no** es un diagnóstico por fila: es `422 COLUMN_MISSING` con `data.fields` y `data.header`, porque afecta a todas las filas por igual.

### 2.8 `LabelTemplatesService.renderRows` (API interna, BE06)

No es un endpoint: es el punto de entrada para quien trae los datos en JSON en vez de en un archivo.

```ts
renderRows(
  accountId: string,
  templateId: string,
  versionNumber: number | undefined,   // undefined = currentVersion
  rows: { values: Record<string, string>; copies?: number }[],
): Promise<{
  zplContent: string;
  labelSize: string;
  labelCount: number;                  // contando copias
  templateId: string;
  templateVersion: number;
}>
```

Comprueba propiedad (`404 TEMPLATE_NOT_FOUND`) y estado (`409 TEMPLATE_ARCHIVED`), valida cada fila con **la misma capa** que CSV/XLSX (tipos, conjuntos de caracteres, fechas ISO, decimales, ceros iniciales en campos `code`) y lanza `422 TEMPLATE_ROW_ERRORS` con `data.rows` cuando algo no cuadra. `copies` es 1..999 y ausente vale 1. Escapa cada valor con `^FH` y garantiza `^CI28`. Topes: 5000 filas y 1000 etiquetas.

**No convierte ni consume cuota**: devuelve el ZPL para que quien llama lo pase a `runDurableConversion` con su propio `operationId`.

## 3. Límites del servidor

| Límite | Valor |
|---|---|
| Etiquetas distintas por lote | ≤ 1000 |
| Etiquetas de un lote **contando copias** | ≤ `maxLabelsPerPdf` del plan |
| Copias por etiqueta | ≤ 999 |
| ZPL de origen | ≤ 4 MB |
| Lotes activos por cuenta | ≤ 50 |
| Exportaciones por lote | ≤ 100 |
| CSV de cotejo | ≤ 2 MB, ≤ 5000 filas |
| Datos CSV/XLSX | ≤ 5 MB, ≤ 5000 filas, ≤ 64 columnas |
| Plantillas por cuenta | ≤ 100; versiones por plantilla ≤ 200 |
| ZPL de plantilla | ≤ 16 KB |
| Etiquetas por ejecución (contando copias) | ≤ 1000 y ≤ `maxLabelsPerPdf` del plan |
| XLSX ya descomprimido | ≤ 64 MB, ≤ 512 entradas en el ZIP, sin ZIP64 |

El tope por plan sale de `DEFAULT_PLAN_LIMITS[plan].maxLabelsPerPdf` y se compara contra las etiquetas **con sus copias**, que es lo que cuenta el conversor; así el rechazo llega al crear el lote y no al exportar. El conversor vuelve a comprobarlo al aceptar la exportación, así que el rechazo es doble y nunca al revés.

## 4. Eventos canónicos

| Evento | Cuándo | `operationId` |
|---|---|---|
| `packing_export_succeeded` | exportación aceptada sin `reexportOf` | `exportId` |
| `packing_reexport_succeeded` | exportación aceptada con `reexportOf` | `exportId` |
| `packing_reconcile_completed` | cotejo persistido | `reconcileId` |
| `template_saved` | plantilla o versión creada (**no es activación**) | UUIDv4 estable por `templateId` + `versionNumber` |
| `template_run_succeeded` | ejecución aceptada | `runId` |

`source` es `api` en todos: `web` está reservado a los eventos de exposición del frontend y el registro canónico lo rechaza en un hecho de servidor. No viaja contenido ZPL, nombres de archivo libres, pedidos, guías ni SKU: solo `labelCount`, `durationMs` y el identificador de operación.

### 4.1 El hecho se escribe con la transición, no después

El hecho **no** se publica después de confirmar el negocio: se construye antes (con su `eventId` y su `occurredAt` definitivos) y se escribe **dentro de la misma transacción** que la transición que lo justifica.

| Transición de negocio | Hecho que va en la misma transacción |
|---|---|
| `completeExport` (exportación → `accepted`) | `packing_export_succeeded` / `packing_reexport_succeeded` |
| `completeRun` (ejecución → `accepted`) | `template_run_succeeded` |
| `createTemplate` (plantilla + versión 1) | `template_saved` |
| `addVersion` (versión nueva) | `template_saved` |
| `updateWorkflow` con el cotejo | `packing_reconcile_completed` |

De ahí salen las dos garantías que antes no existían:

- Si la transacción no confirma, **no hay ni transición ni hecho**. No queda un hecho suelto de una exportación que nunca se aceptó.
- Si confirma y el proceso muere antes de entregar, **el hecho ya está guardado**. La entrega inmediata posterior es una optimización, no el sitio donde vive el dato.

No queda ningún `catch` que se trague un hecho. La única excepción del módulo, marcada como tal en el código, es guardar el mapeo de columnas después de una ejecución ya convertida: es una comodidad que el operador puede volver a elegir, no un hecho, y fallar ahí invalidaría una conversión ya cobrada.

### 4.2 Cola de salida (`label_event_retries`)

```ts
interface OutboxEventRecord {
  id: string;                 // = eventId (UUIDv4); es el id del documento
  accountId: string;          // en la raíz: permite filtrar y barrer por cuenta
  eventName: string;
  operationId: string;
  event: LabelServerEvent;    // payload exacto que se entrega
  status: 'pending' | 'dead';
  attempts: number;
  lastErrorCode?: 'recorder_rejected' | 'recorder_unavailable' | 'no_recorder_configured';
  createdAt: string;
  updatedAt: string;
  availableAt?: string;       // AUSENTE cuando status es 'dead'
  leaseToken?: string;        // fencing
  leaseExpiresAt?: string;
}
```

- **Lease con token.** Reclamar fija `leaseToken` y `leaseExpiresAt` (60 s). Confirmar y fallar son condicionales al token: un consumidor que perdió el lease **no** borra el trabajo del que se lo quitó, devuelve `lost`. Dos drenados simultáneos entregan el hecho una sola vez.
- **Espera creciente** entre intentos (2, 4, 8… minutos) con tope de una hora, y **ocho intentos** como máximo.
- **Muerte explícita.** Al octavo fallo el estado pasa a `dead` y **se elimina el campo `availableAt`**, no se pone una fecha centinela. La consulta del drenado filtra por `availableAt`, así que un muerto deja de aparecer solo, sin índice compuesto y sin fechas imposibles en los datos. El documento **no se borra**: es la evidencia de un hecho que ocurrió y no se pudo registrar.
- **Errores como códigos cerrados.** En el documento solo entra uno de los tres códigos de arriba. El mensaje de la excepción nunca se guarda: puede arrastrar contenido de la etiqueta, ids de documento o detalles internos de Firestore, y este estado se lee desde paneles de operación.
- **Reentrega sin duplicar.** El `eventId` y el `occurredAt` se fijan al escribir, así que una reentrega lleva el mismo `eventId` y el registro la deduplica por entrega y por operación semántica.

`LabelEventPublisher.retryPending(limit = 20)` drena la cola y devuelve `{ claimed, delivered, pending, dead, lost }`. Está exportado por los dos módulos. **Este cambio no programa nada**: conectar la tarea (OIDC) y la limpieza de muertos es del despliegue.

### 4.3 Cuenta borrada

Toda escritura de negocio comprueba `deleted_accounts/{accountId}` **dentro de su propia transacción**, no antes: entre un chequeo suelto y la escritura cabe una baja de cuenta. Cubre crear lote, reordenar, selección, copias, cotejo, reservar y completar exportación, añadir `jobRef`, crear plantilla, versión, actualizar plantilla, y reservar y completar ejecución. Si la lápida está, la operación devuelve `410 ACCOUNT_DELETED` y no se escribe ni la transición ni el hecho.

## 5. Índices de Firestore necesarios

Colecciones: `label_workflows`, `label_workflows/{id}/labels`, `label_workflow_exports`, `label_templates`, `label_template_versions`, `label_template_runs` y `label_event_retries`.

`label_event_retries` **no necesita índice compuesto**: el drenado consulta solo `availableAt`, que es un campo único, y los hechos muertos no tienen ese campo, así que quedan fuera sin filtrar por `status`.

El campo de propiedad es `ownerId` en los lotes, las plantillas y las versiones, y `accountId` en las exportaciones y las ejecuciones. Los comandos son los del listado real que hacen los servicios:

```bash
gcloud firestore indexes composite create --project=zplpdf-guatever --collection-group=label_workflows --field-config=field-path=ownerId,order=ascending --field-config=field-path=createdAt,order=descending --field-config=field-path=id,order=descending

gcloud firestore indexes composite create --project=zplpdf-guatever --collection-group=label_workflows --field-config=field-path=ownerId,order=ascending --field-config=field-path=status,order=ascending --field-config=field-path=createdAt,order=descending --field-config=field-path=id,order=descending

gcloud firestore indexes composite create --project=zplpdf-guatever --collection-group=label_workflow_exports --field-config=field-path=accountId,order=ascending --field-config=field-path=workflowId,order=ascending --field-config=field-path=createdAt,order=descending

gcloud firestore indexes composite create --project=zplpdf-guatever --collection-group=label_templates --field-config=field-path=ownerId,order=ascending --field-config=field-path=createdAt,order=descending

gcloud firestore indexes composite create --project=zplpdf-guatever --collection-group=label_template_versions --field-config=field-path=ownerId,order=ascending --field-config=field-path=templateId,order=ascending --field-config=field-path=versionNumber,order=descending

gcloud firestore indexes composite create --project=zplpdf-guatever --collection-group=label_template_runs --field-config=field-path=accountId,order=ascending --field-config=field-path=templateId,order=ascending --field-config=field-path=createdAt,order=descending
```

El índice de `label_workflows` con `status` cubre además el recuento de lotes activos (`ownerId` + `status in [draft, ready]`), que usa su prefijo. El de `label_workflow_exports` cubre también `countExports`. Ninguna consulta usa `accountId` y `ownerId` a la vez.

TTL (`expiresAt`, `Timestamp` nativo) para `label_workflows` y su subcolección `labels`: se habilita fuera de este cambio. TTL no es borrado inmediato, así que `sourceExpiresAt` se comprueba también en lectura. Las plantillas, sus versiones y las ejecuciones no llevan `expiresAt`: duran mientras la cuenta las conserve.

**Cliente de Firestore.** Los dos módulos toman el cliente ya configurado con `FirestoreService.getClient()` (providers `WORKFLOWS_FIRESTORE` y `TEMPLATES_FIRESTORE`): mismas credenciales, mismo proyecto y misma configuración de emulador que el resto de la aplicación, sin abrir una segunda conexión ni leer otra variable de entorno.

**Estructura del lote.** El documento padre guarda la metadata, `orderIds`, `selectedIds`, `version` y el resultado del cotejo por etiqueta; el contenido de cada etiqueta vive en la subcolección `labels` y es inmutable. Así toda mutación del lote —orden, selección, cotejo— es una sola escritura con CAS, y un lote de 1000 etiquetas no choca con el límite de 1 MB por documento ni con el de 500 escrituras por transacción.

## 6. Integración pendiente (coordinador)

1. Importar `WorkflowsModule` y `LabelTemplatesModule` en `AppModule`. Los dos importan `ProductObservabilityModule` y ya registran sus adaptadores: `FEATURE_GATE` → `FeatureFlagsService`, `LABEL_EVENT_RECORDER` → `ProductObservabilityService`, `XLSX_WORKBOOK_READER` → `ExcelJsWorkbookReader`. No hace falta enlazar nada más.
2. Encender los flags `packing_workflow` y `data_templates` en `PRODUCT_FEATURE_FLAGS` cuando toque: están apagados, y con el flag apagado el acceso se deniega con `403`.
3. Crear los índices de §5 y habilitar TTL.
4. Añadir el barrido de estas colecciones a la eliminación de cuenta antes de habilitar producción.
5. Conectar `LabelEventPublisher.retryPending(limit)` a una tarea con OIDC o a un endpoint de administración, y decidir la limpieza de los `dead`. Sin eso, un hecho que falle al entregarse se queda en `label_event_retries` sin drenar (guardado, no perdido).
6. Decidir si los códigos de error propios de estos módulos se consolidan en `src/common/constants/error-codes.ts` (hoy viven en `workflow-error-codes.ts` y `template-error-codes.ts` para no tocar archivos compartidos).
7. **`.gitignore` ignora `docs/*`**, así que este contrato y el de observabilidad no entran en ningún commit tal como están. Hace falta una excepción (`!docs/growth/`) o mover los contratos a una ruta versionada; es un archivo compartido y esta entrega no lo toca.

## 7. Qué está probado y qué no

187 pruebas en `src/modules/workflows` y `src/modules/label-templates` (`npx jest src/modules/workflows src/modules/label-templates`), con `tsc --noEmit` y `eslint --max-warnings=0` limpios sobre esas dos rutas.

Evidencia concreta de la atomicidad del hecho, en `workflows.service.spec.ts`, `template-runs.service.spec.ts` y `label-event.publisher.spec.ts`:

| Qué se prueba | Cómo |
|---|---|
| Caída **antes** de confirmar | Se fuerza el fallo de la transacción: no queda exportación/ejecución `accepted`, no queda hecho, y el reintento produce exactamente uno de cada. |
| Caída **después** de confirmar | La entrega inmediata falla: la transición está aceptada, el hecho sigue en la cola con su `accountId`, y el drenado posterior lo entrega. |
| Reintento del mismo hecho | Entrega inmediata + drenado sobre el mismo documento: el registro lo ve una vez; si se reentrega, llega con el mismo `eventId` y `occurredAt`. |
| Concurrencia y lease vencido | Un lease vivo bloquea a otro consumidor; uno vencido se roba, y el token viejo ya no confirma ni falla (devuelve `lost`) ni borra el documento. |
| Muerte explícita | Ocho fallos → `status: 'dead'`, el campo `availableAt` desaparece y el drenado deja de verlo aunque pase un año; el documento sigue ahí. |
| Códigos de error | Se comprueba que el texto de la excepción (rutas, ids) **no** aparece en el documento y que el código distingue rechazo de validación de caída. |
| Lápida de cuenta | Con `deleted_accounts` marcado, exportar, cotejar, crear lote, crear plantilla, añadir versión y ejecutar devuelven `410 ACCOUNT_DELETED` sin dejar hechos; otra cuenta sigue funcionando. |

El resto de la cobertura: paridad de recuento y orden con el conversor real, aislamiento entre cuentas, conflicto de versión (CAS), idempotencia por intención con una sola conversión y `operationId` UUIDv4 estable, copias `^PQ` de ida y vuelta, override de copias y rechazo de serializadas, los cinco estados del cotejo, ceros iniciales y acentos en CSV y XLSX, inyección de ZPL desde los datos y desde `renderRows`, versiones inmutables, fórmulas y macros de XLSX, inspección de columnas y el rechazo por función no soportada. Una prueba instancia los dos módulos de Nest y comprueba que la cola de salida y `retryPending` se resuelven.

Lo que **no** cubren, y sigue haciendo falta antes de habilitar producción:

- **Firestore real.** Las pruebas usan implementaciones en memoria de los mismos puertos, con la misma semántica de transacción (transición y hecho se escriben o no se escriben juntos), de lease con token y de lápida. La versión de Firestore usa `runTransaction` y `FieldValue.delete()`, pero **no se ha ejecutado contra el servicio**: falta una pasada con emulador o staging para las transacciones, los índices y el `count()`.
- **Labelary y el PDF físico.** El puente `runDurableConversion` se sustituye por un doble: se comprueba el ZPL y el `operationId` que se le entregan, no el PDF ni la reserva de cuota real, que son suyos.
- **Paridad con el conversor.** `converter-parity.spec.ts` compara el recuento y el orden del lote con `ZplService.countLabels` sobre siete casos; lo que sigue sin comprobarse es que Labelary pagine ese ZPL como se espera.
- **Expansión del XLSX.** El tope se decide leyendo los tamaños que declara el directorio central del ZIP. Un archivo malformado que declare menos de lo que ocupa seguiría entrando; los topes de entrada y de filas acotan el daño.
- **Limpieza de muertos.** Un hecho `dead` se queda en la colección hasta que alguien decida qué hacer con él: no hay barrido y es deliberado, porque borrarlo destruiría la evidencia.
