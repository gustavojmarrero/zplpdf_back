# Independent root integration review — BE06–09

Reviewed 2026-09-17, dispatch `ctx_218e66812830`. Changes are limited to `pdf-preparation`, `folder-automation`, `public-api`, and this report. No provider calls, production changes, commits, frontend changes, financial emulator use, or edits to the other owners' modules.

## Findings and corrections

| Severity | Reproduced defect | Correction and evidence |
| --- | --- | --- |
| High | PDF parsing, decompression and layout ran in the request thread with no deadline or heap isolation. A test forbidding `PDFDocument.load` in that thread failed before correction. | The engine runs in a worker with a 30-second deadline, 128 MiB old-generation heap, 16 MiB young-generation heap, 4 MiB stack, and at most two concurrent workers per process. Capacity is released only after termination; excess work returns `PDF_PREPARATION_BUSY`. Real-worker tests cover termination, recovery, concurrency and request-thread isolation. This is **not a total RSS limit**, as explained below. |
| High | API cancel/retry could write after an account tombstone; completion during deletion could recreate counters and callbacks. Three reproductions failed before correction. | Transactional tombstone checks now fence cancel, retry, worker claim, renewal, reschedule and finalization. Tests prove no mutation after deletion, including a counter already removed during conversion. |
| Medium | Different crops of one PDF page created separate embedded streams, multiplying decoded content. The regression fixture produced 24 Form XObjects for 24 crops. | Embed each selected source page once and clip each placement in output coordinates. The same fixture now has one Form XObject, retaining all 24 selections. Raster verification confirmed colored sample positions and outside clipping for all four rotations with a negative media-box origin. |
| Medium | Drive accepted completion from an expired time lease after upload. The reproduction incorrectly reached `succeeded`. | Finalization checks lease expiry as well as token/status. A fresh worker recovers the provider receipt without another download/upload and records success. |
| Medium | OAuth exchanges rejected for insufficient scopes or missing refresh token left their provider grant live without a revocation receipt. Both cases produced zero revocations before correction. | Encrypt the returned refresh token, or access token if offline access is absent, into the existing durable revocation outbox. Tests verify eventual provider revocation and secret removal without creating a connection. |
| Medium | Presets rejected negative crop coordinates even when export accepted them for a negative-origin media box. The preset test failed with `PDF_CROP_OUTSIDE_PAGE` after direct export succeeded. | Presets validate finite coordinates and positive dimensions; export still checks the rectangle against each actual source. Regression proves persistence and rejection when applied to an incompatible positive-origin source. |

## Integration coverage

Added full Drive configuration → discovery → execution → private result/provider upload tests using MemoryDb and real materializers. The PDF path uses the real PDF engine, PDF preparation service and durable quota repository; a queued version-one recipe survives configuration of version two and archival, retains 288 × 432 pt output, and charges one conversion. CSV and XLSX use the real `TemplateRunsService.materializeFileSnapshot`, typed mapper, renderer and ExcelJS reader, with only the final ZPL conversion/provider/storage boundaries mocked; leading zeros, copies, original operation identity, archive and pause/resume are verified. Connection/run responses omit materialized snapshots, source values and signed output URLs.

Additional preset coverage exercises the concurrent 50th slot, idempotent archive capacity release, immutable create/update replay after archive, the version-200 boundary, source-independent retention and tombstones. Existing API tests continue to cover immutable `testMode`, normal conversion boundary, synthetic success/callback markers, ownership, idempotency, dead callback retry and transport protection. The schema-only test controller was reviewed: its API-key/scope guard and feature check lead only to a fixed fixture response, with no renderer/job dependency; no defect was found there.

## Final evidence

- `npx jest --runInBand src/modules/pdf-preparation src/modules/folder-automation src/modules/public-api`: **5 suites / 94 tests passed**.
- `npm run typecheck`: passed.
- Scoped ESLint of all three TypeScript domains with `--max-warnings=0`: passed; the worker engine JavaScript asset also passed ESLint with `project:null` because it is a runtime asset.
- `npm run build`: TypeScript found zero issues; SWC compiled 352 files and the existing Nest `**/*.js` asset rule copied the engine.
- A real `NODE_ENV=production` conversion imported `dist/modules/pdf-preparation/pdf-layout.js`, loaded its ESM engine asset, produced a one-label PDF (1611 bytes), verified 288 × 432 pt dimensions, terminated a deadline-limited worker and successfully converted again afterward. No providers were involved. Explicit worker `execArgv: []` prevents inherited `--input-type`/debugger flags from changing its CommonJS bootstrap.
- Input above 20 MiB and a synthetic input below 20 MiB that expands to serialized output above 20 MiB both fail at their respective byte boundaries.
- Independent Poppler rendering at 72 dpi plus raw pixel checks passed for 0/90/180/270° clockwise rotation, negative media-box origin, crop positions and absence of content outside the crop.
- The existing real-Firestore tests were not rerun: no emulator was needed for these reproductions, and the prior seven-test evidence remains the coordinator's baseline.

## Residual risks and handoff

Worker `resourceLimits` constrain V8 heap/stack, **not ArrayBuffer, Buffer, native allocations, or total process RSS**. A highly compressed PDF can still consume substantial native memory inside the shared process before its deadline. Reusing cropped pages removes one demonstrated multiplier, but deployment still needs an appropriate container memory budget or stronger process/cgroup isolation if a hard per-document RSS guarantee is required. No native-memory security guarantee or hostile-PDF production load claim is made. The two-worker cap is per application process, not a distributed limit.

The engine asset follows the existing application's project-root working-directory convention (`src` under Jest, `dist` in production); this exact production path was smoke-tested. New controlled operational errors are `PDF_PROCESSING_TIMEOUT`, `PDF_PROCESSING_LIMIT` (400), and `PDF_PREPARATION_BUSY` (503); the coordinator can add them to the FE contract if needed. The signed-coordinate preset change does not alter the recipe schema.

No raw provider exceptions, tokens, source ZPL or user URLs are logged by the three reviewed domains. Worker stdout/stderr are explicitly drained without forwarding and parser errors are mapped to an allowlist. An adjacent, out-of-ownership boundary remains worth owner review: `label-templates/tabular/exceljs-workbook-reader.ts` logs the raw ExcelJS error message for an unreadable workbook; this review did not demonstrate a source-content leak there and did not edit it. Drive outputs inherit the selected folder's existing ACL; this code creates no public sharing permissions, and tests do not claim to audit users' Drive ACLs.
