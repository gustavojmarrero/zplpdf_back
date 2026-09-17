# Private incident operations

Admin Firebase token + existing AdminAuthGuard allowlist required. Nothing is public. Existing admin audit records the operation path and actor.

GET `/api/admin/growth/incidents?queue=product_events|label_events|drive_revocations|api_callbacks` returns `{schemaVersion:1,queue,truncated,items:[{id,status,attempts:number|null,errorCode:string|null,createdAt:string|null}]}`. At most50 terminal failures; if truncated do not present the list length as a total. No payload, tokens, endpoint URLs, account IDs, emails or source content are returned.

POST `/api/admin/growth/incidents/:queue/:id/retry` returns202 `{schemaVersion:1,queue,id,status:'queued'}`. It only schedules another attempt after an administrator has addressed the cause; it does not synchronously contact a provider. The underlying queue rechecks current state transactionally. Label events preserve the original canonical event identity and check account deletion; callbacks require a live endpoint and unexpired delivery; Drive revocation may legitimately outlive account deletion so access can be revoked and encrypted secrets removed. 409 means no longer retryable; refresh the list.

Present explicit manual retry, loading/error/result states and refresh after acknowledgement. Do not automatically click/retry failures, include these item IDs in COE exports, or describe queue acceptance as successful delivery. Signed callback retries reuse their event identity, so receivers must deduplicate as usual.

Product-event incident IDs are 64 lowercase hex characters; other queues use UUIDv4. Product retries preserve the canonical event key, require non-expired source data and reject deleted accounts. If source data has already expired, manual retry cannot recreate it: the incident remains for reconciliation.
