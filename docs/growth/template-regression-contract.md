# BE10 / FE07 contract (schemaVersion 1)

All routes below have the global `/api` prefix, require Firebase bearer authentication and the server `template_regression` feature flag. Every resource belongs to the authenticated UID; foreign IDs return 404. JSON requests reject unknown fields. No client renderer URLs, object paths, hashes, or account IDs are accepted.

```ts
type LabelSize = '2x1' | '2x4' | '4x2' | '4x6' | '50x80mm' | '80x50mm';
type Mask = { x: number; y: number; width: number; height: number };
type Renderer = {
  rendererId: 'labelary-8dpmm';
  rendererVersion: null;
  verification: 'unversioned_provider';
};
type Artifact = { sha256: string; url: string | null };
type Baseline = {
  id: string;
  operationId: string;
  name: string;
  version: number;
  status: 'processing' | 'ready' | 'approved' | 'failed';
  labelSize: LabelSize;
  renderer: Renderer;
  source: Artifact | null;
  image: Artifact | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalNote: string | null;
  artifactsExpireAt: string;
  metadataExpireAt: string;
  errorCode: string | null;
  fixtureId: string | null;
  fixtureVersion: 1 | null;
};
type Run = {
  id: string;
  operationId: string;
  baselineId: string;
  baselineVersion: number;
  version: number;
  status: 'processing' | 'completed' | 'failed';
  labelSize: LabelSize;
  renderer: Renderer;
  source: Artifact | null;
  image: Artifact | null;
  diffImage: Artifact | null;
  visual: null | {
    status: 'compared' | 'dimensions_changed';
    passed: boolean;
    width: number;
    height: number;
    candidateWidth: number;
    candidateHeight: number;
    comparedPixels: number | null;
    changedPixels: number | null;
    changedRatio: number | null;
  };
  payload: null | {
    changed: boolean;
    baselineSha256: string;
    candidateSha256: string;
  };
  options: { masks: Mask[]; channelTolerance: number; maxChangedRatio: number };
  adoptedBaselineId: string | null;
  createdAt: string;
  artifactsExpireAt: string;
  metadataExpireAt: string;
  errorCode: string | null;
};
type CreateBaseline = {
  operationId: string;
  name: string;
  zpl: string;
  labelSize: LabelSize;
  fixtureId?: string;
};
type CreateRun = {
  operationId: string;
  baselineId: string;
  baselineVersion: number;
  zpl: string;
  labelSize: LabelSize;
  options?: {
    masks?: Mask[];
    channelTolerance?: number;
    maxChangedRatio?: number;
  };
};
```

| Method / route                                        | Request                                                          | Exact success envelope                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET `/template-regression/baselines`                  | none                                                             | `{ schemaVersion: 1, baselines: Baseline[] }`                                                                        |
| POST `/template-regression/baselines`                 | `CreateBaseline`                                                 | `{ schemaVersion: 1, baseline: Baseline }`                                                                           |
| GET `/template-regression/baselines/:id`              | UUIDv4                                                           | `{ schemaVersion: 1, baseline: Baseline }`                                                                           |
| POST `/template-regression/baselines/:id/approve`     | `{ expectedVersion: number, note: string }`                      | `{ schemaVersion: 1, baseline: Baseline }`                                                                           |
| GET `/template-regression/runs`                       | none                                                             | `{ schemaVersion: 1, runs: Run[] }`                                                                                  |
| POST `/template-regression/runs`                      | `CreateRun`                                                      | `{ schemaVersion: 1, run: Run }`                                                                                     |
| GET `/template-regression/runs/:id`                   | UUIDv4                                                           | `{ schemaVersion: 1, run: Run }`                                                                                     |
| POST `/template-regression/runs/:id/approve-baseline` | `{ expectedVersion: number, operationId: string, note: string }` | `{ schemaVersion: 1, baseline: Baseline, run: Run }`                                                                 |
| GET `/template-regression/fixtures`                   | none                                                             | `{ schemaVersion: 1, fixtures: Array<{ id: string, version: 1, name: string, zpl: string, labelSize: LabelSize }> }` |

Creation is synchronous with durable processing state. IDs equal client UUIDv4 `operationId`; retry the identical POST after a transport failure. Active lease returns 409 `OPERATION_IN_PROGRESS`; changed input under the same ID returns 409 `OPERATION_PAYLOAD_CONFLICT`. GET exposes processing/failed state; retries are capped at eight. Lists return the latest 50 records. State versions begin at 1 and increment at completion, failure/reclaim and approval. `baselineVersion` must equal the current approved baseline version at run creation; otherwise 409. A run uses the immutable baseline image captured by that ID.

Approval is explicit. Both approval routes require a trimmed note of 1–500 characters, persisted with the authenticated author as `approvalNote` and `approvedBy`. Baseline approval uses its current `version`. Candidate adoption uses the current **run** `version` and a **new** UUIDv4 `operationId`; it creates an approved baseline with that ID, preserves the original baseline and candidate, and records the new ID on the run. Retrying the identical adoption returns the same baseline; a different adoption of an already adopted run conflicts. Do not automatically approve after a matching diff. Neither approval event is activation.

`visual.passed` means only that decoded pixels outside masks satisfy the chosen threshold; payload difference is separately reported using SHA-256 of exact UTF-8 ZPL bytes. Neither result certifies barcode readability, media, paper, printer calibration, or physical print quality. Renderer metadata describes the fixed 8dpmm provider profile; Labelary supplies no verifiable engine release, so the version is null and verification is `unversioned_provider`.

Limits: exact one complete ZPL label with a drawable field (empty/configuration/comment-only blocks are rejected), quantity one, 128 KiB UTF-8 input, known label size, PNG only, at most 16 million decoded pixels and 20 MiB encoded image; at most 20 integer rectangular masks within baseline dimensions covering at most 25% of pixels (conservative summed area, so overlaps count twice); channel tolerance 0–64 (default 8), maximum changed ratio 0–0.1 (default 0.005). Unsupported ZPL control/download commands are rejected to prevent label-count bypasses. Missing/expired artifacts return 410 for dependent actions; expired artifact URLs become null while metadata remains readable. No input normalization is applied to the payload hash; the existing `ZplService.getLabelsPreview` renderer normalizes whitespace and quantity commands internally.

Artifacts (source ZPL, PNG and diff PNG) are private under `debug-zpl/<uid>/regression/`, expire after 15 days, and receive fresh 15-minute signed URLs only on authorized reads. Metadata and idempotency expire after 90 days. Server-side SHA-256 is authoritative. Nest error envelopes use `{ statusCode, message, error }`; no provider error details or source ZPL are exposed in errors.

## Integration and real prerequisites

- Import `TemplateRegressionModule` from `src/modules/template-regression/template-regression.module.ts`; it exports `TemplateRegressionService`. The module imports Firebase Auth, Cache/Firestore, private Storage, ZPL rendering and ProductObservability. Root owns AppModule integration.
- Invoke `TemplateRegressionService.recover()` from the root-owned scheduler endpoint protected by the existing OIDC scheduler guard. It returns `{ scanned, recovered, failed }`, scans at most 50 due operations, uses a ten-minute lease and a new opaque token per attempt, and caps attempts at eight. Retryable failures are due again after one minute. Exhausted/expired work is removed from the due queue. There is no public recovery endpoint in this module.
- Persisted collections are `template_regression_baselines`, `template_regression_runs`, and `template_regression_operations`. Every document has `accountId` and `expiresAt` (Firestore Timestamp, 90 days). Include all three in account cleanup and Firestore TTL configuration. Every business transaction checks `deleted_accounts/<uid>` and the live `users/<uid>` document before writes; late storage writes are removed when deletion is detected.
- Composite indexes: baselines and runs each require `accountId ASC, createdAt DESC`; operations require `status ASC, leaseUntil ASC`. Recovery uses `status in ['processing','failed']` and `0 < leaseUntil <= now`.
- Private bucket IAM and an enforced 15-day lifecycle for `debug-zpl/` must exist in the deployed environment. Application reads and approvals enforce the stored 15-day deadline independently; adopted baselines retain their candidate's original artifact deadline. This worker did not deploy or inspect live bucket lifecycle/Firestore TTL settings.
- Enable a valid server `PRODUCT_FEATURE_FLAGS.template_regression` entry only for the intended rollout, and configure the existing Labelary queue/provider credentials and private GCS signing permissions. No arbitrary provider URL is fetched: only the data PNG returned by `ZplService.getLabelsPreview(..., { maxUniqueLabels: 1 })` is accepted.
- Completed run state, `regression_run_completed`, semantic dedup and its observability outbox are committed in one Firestore transaction. This also occurs when pixels differ or dimensions change. Explicit approval commits `baseline_approved` atomically; it is not an activation event. Synthetic fixture origin propagates through runs and adopted baselines to event synthetic markers.
- An uploaded render is checkpointed before final completion. Recovery reuses that checkpoint and verifies source/image/diff hashes, so an event/outbox failure does not rerender an already captured candidate. Attempt-specific image paths fence late writers; immutable published captures are never overwritten. A crash before the first render checkpoint may rerender using the provider's then-current unversioned engine; this cannot be certified as the same engine release.

## Verification evidence (2026-09-17, local, no real provider calls)

- `npx jest --runInBand src/modules/template-regression` — **2 suites, 40 tests passed**. The three original image-diff tests are retained; an additional grayscale/RGB normalization case protects decoded-channel comparisons.
- `npx eslint 'src/modules/template-regression/**/*.ts' --max-warnings=0` — passed.
- `npx tsc --noEmit` — passed across the shared backend workspace at verification time.
- Tests use a serial, rollback-capable Firestore fake enforcing reads before writes, private in-memory Storage, synthetic Sharp PNGs, and a mocked renderer. Coverage includes concurrent duplicate claims, CAS races, explicit note/author approval, candidate adoption/idempotency, stale tokens, crash recovery, eight-attempt exhaustion, event rollback and retry, the real `ProductObservabilityService` + event repository/outbox boundary, foreign-account requests/lists, Firebase HTTP 401/403/404, unknown fields, masks/area/dimensions, separate payload equality, 16Mpx rejection, provider URL rejection, source/image tampering, expiry, deletion races and all ten versioned fixture inputs.
- This evidence establishes local implementation behavior. Live provider rendering, deployed scheduler/IAM/index/TTL setup, frontend integration, physical printing and barcode scanning were not exercised by this worker. No tour, deployment or commit is part of this task.
