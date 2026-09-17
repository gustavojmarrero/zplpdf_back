# BE04/BE05 reservation, recovery and retention review

Date: 2026-09-17. Worker task: `task_a74fdcb419da`, dispatch `ctx_c9c60c6086d3`.

## Result

Implemented token-fenced export/run reservations and immutable acceptance in both Firestore and memory repositories. Successful operations cannot be changed to failed by a late worker, and a late completion cannot create a second canonical outbox event or recreate an acknowledged event. The public frontend response shapes remain compatible; private retry context, tokens, attempts, completion events and retention metadata are not exposed by template run responses.

All **224 tests in 15 workflow/template suites pass** (187 existing tests plus 37 new regressions). Repository-wide TypeScript checking and scoped ESLint pass. This worker did not run the shared Firestore emulator or call a live conversion/preview provider; independent emulator validation remains with the coordinator.

## Reservation and completion changes

- `operation-lease.ts` supplies the decision logic shared by both storage implementations. Each successful reserve/reclaim generates a fresh opaque UUID token and increments attempts, capped at eight. A live lease blocks another claim. Reclaim preserves the original record and pinned inputs instead of copying a newly computed candidate.
- Leases now last 12 minutes, exceeding the converter's original 10-minute lease. `withOperationLease` renews every 30 seconds during conversion, prevents overlapping renewals, joins in-flight renewal before settling, and stops the timer on every exit. Completion, failure and renewal require the current unexpired token and pending status.
- Accepted records are immutable to completion/failure retries. A redundant completion returns the stored acceptance without writing the supplied event. The first completion atomically stores acceptance, its `completionEvent`, and its outbox record. Services deliver only the persisted canonical event, never a losing worker's newly prepared event.
- Firestore reservation/completion/failure/renewal and the new account-liveness port check `deleted_accounts`. Memory repositories mirror the checks and clone operation records, including nested retry context and persisted completion data.
- Repository signatures are `completeExport/completeRun(id, token, patch, outbox)`, `failExport/failRun(id, token, errorCode)`, and `renewExport/renewRun(id, token)`. `reserve*` returns the token in `record.leaseToken`.
- Every conversion retry keeps the original deterministic export/run UUID as the durable converter `operationId`; no second quota identity is introduced.

## Pinned inputs and post-acceptance behavior

Exports retain the first workflow metadata snapshot (selection/order/copy overrides/size/name/output/source expiry, excluding unnecessary reconciliation/job/source-reference payloads). Immutable child labels reconstruct the same converter input after later workflow edits. Template runs retain the chosen immutable template version, resolved mapping, original filename, and a hash of request inputs; retrying with changed input is rejected before conversion. Raw CSV/XLSX is not persisted by these domain records: recovery requires the original request data.

`appendJobRef` and mapping persistence are ancillary after acceptance. Their failure is logged without changing the result or failing the request. An accepted export replay retries its missing job reference using persisted result values. A losing template worker does not overwrite saved mapping. Late converter failures return an already accepted result when the fenced repository confirms one exists. Event delivery failures leave the committed outbox for its existing drainer.

Legacy unfinished records lacking the pinned context fail closed with `OPERATION_REPLAY_CONTEXT_MISSING`; they are not silently reinterpreted using current workflow/template state. They require operator reconciliation with durable conversion evidence. Existing accepted records remain immutable.

## Retention and explicit outbox recovery

Both operation collections now persist `expiresAt` as a **native Firestore Timestamp**, fixed at `createdAt + 90 days`. The domain/memory form is ISO text; `operation-lease.firestore.ts` encodes/decodes the storage boundary. Reclaims and acceptance preserve the original expiry. Expired replay/reclaim/renewal is rejected with `OPERATION_EXPIRED`; records are not deleted by these methods. Legacy expiry is derived from `createdAt` when needed.

**Cleanup policy for the coordinator:** do not enable unconditional native Firestore TTL on `label_workflow_exports` or `label_template_runs`. Use a status-aware cleanup job for accepted records past expiry; retain pending/failed records as unresolved recovery evidence until an explicit operator decision. The existing workflow/source-label 15-day retention remains separate, and template definitions/versions remain persistent. This worker did not configure a cleanup job or TTL policy.

`label_event_retries` dead records have no automatic TTL. They remain evidence until operator resolution or account deletion. `LabelEventOutboxPort.requeueDead(accountId, eventId, now): Promise<boolean>` is an internal admin port, with no public HTTP endpoint. It only moves an owned `dead` record to pending, checks the account tombstone, keeps the exact event ID/body/original time, clears stale leases, and records `manualRetries`, cumulative `previousAttempts`, and `lastManualRetryAt`. Each explicit manual cycle gets the normal bounded delivery attempts; concurrent/duplicate requests cannot requeue an already pending fact. An old consumer cannot acknowledge the new cycle.

## Coordinator-requested additions

### Workflow thumbnails

`POST /workflows/:id/preview`, Firebase-authenticated, accepts `{ "labelIds": ["..."] }`, 1–10 distinct owned IDs, and returns `{ "schemaVersion": 1, "items": [{ "labelId": "...", "dataUrl": "data:image/png;base64,..." }] }` in request order. `WorkflowPreviewService` checks the packing feature, ownership, source expiry and account tombstone before rendering. It uses private stored ZPL only and calls the existing `getLabelsPreview` with `maxUniqueLabels: 1` per distinct group (at most 10 groups). Identical groups share one rendered image; copied labels retain their requested identity without multiplying render work. Individual renderer failure becomes an explicit 503, preventing index shifts from associating an image with the wrong label. No PDF conversion, quota reservation or export event is generated.

The exact contract was relayed to the coordinator for frontend dispatch `ctx_7f4e10054f0e`.

### Drive snapshot materialization

Public server-side method:

```ts
TemplateRunsService.materializeFileSnapshot(
  accountId: string,
  version: TemplateVersionRecord,
  dto: ValidateRunDto,
): Promise<{ zplContent: string; labelSize: string; labelCount: number }>
```

The caller supplies a trusted, server-loaded immutable version snapshot. The method verifies account/owner, feature and tombstone; reuses CSV/XLSX parsing, mapping, row diagnostics, plan/absolute quantity limits, injection checks and escaped rendering. Invalid rows or zero valid rows reject the materialization. It creates no template run, emits no template success event, and performs no conversion or quota operation. The coordinator owns Drive's durable conversion and folder success event.

## Verification

Commands run successfully after the final implementation:

```sh
npx jest --runInBand --testPathPattern='modules/(workflows|label-templates)/'
npx tsc --noEmit
npx eslint 'src/modules/workflows/**/*.ts' 'src/modules/label-templates/**/*.ts' --max-warnings=0
```

Regression coverage includes stale completion/failure/renewal before and after takeover, immutable accepted results, no duplicate or resurrected outbox, crash before/after acceptance, tombstones, eight-attempt exhaustion, 15-minute conversion renewal, pinned workflow/template edits, ancillary write failure, service-level suspended workers, 90-day retention/expiry, native Timestamp encoding, safe dead-event requeue, preview ownership/feature/expiry/limits/group identity/failure, and CSV/XLSX Drive materialization with owner/tombstone/input/quantity checks. One existing unused catch binding in the owned event publisher was renamed for scoped lint.

## Files changed by this worker

- `src/modules/workflows/operation-lease.ts` (new shared lease/retry/retention logic)
- `src/modules/workflows/operation-lease.spec.ts` (new repository/recovery regressions)
- `src/modules/workflows/operation-lease.firestore.ts` and `.spec.ts` (new native Timestamp boundary)
- `src/modules/workflows/workflows.types.ts`, `workflows.constants.ts`, `workflows.firestore-repository.ts`, `workflows.in-memory-repository.ts`
- `src/modules/workflows/workflow-exports.service.ts`, `workflows.service.spec.ts`
- `src/modules/workflows/workflow-preview.service.ts` and `.spec.ts` (new)
- `src/modules/workflows/workflows.controller.ts`, `workflows.module.ts`, `dto/workflow-request.dto.ts`
- `src/modules/workflows/label-event.outbox.ts`, `label-event.store.ts`, `label-event.publisher.ts`, `label-event.publisher.spec.ts`
- `src/modules/label-templates/label-templates.types.ts`, `label-templates.constants.ts`, `label-templates.firestore-repository.ts`, `label-templates.in-memory-repository.ts`
- `src/modules/label-templates/template-runs.service.ts`, `template-runs.service.spec.ts`
- This report.

## Remaining limits

Domain recovery is triggered by a matching client/server retry, not a new background sweeper. Source deletion/expiry, missing legacy pinned context, expired metadata and exhausted attempt budgets require explicit reconciliation and cannot safely start a substitute operation. The converter remains responsible for its own storage/result durability and quota fence; these services retain its operation UUID. Outbox transport remains at-least-once with stable canonical identity and recorder deduplication; the guarantee here is one persisted canonical fact per accepted operation, not exactly-once network delivery. Status-aware retention cleanup, an authenticated admin integration for manual dead-event retry, and independent real-Firestore integration evidence belong to the coordinator. No frontend edits, deploys, commits, provider calls or tour were performed.
