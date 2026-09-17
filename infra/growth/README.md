# Growth scheduler

Application validates the Google-signed OIDC token audience and exact service-account email even on a publicly accessible Cloud Run service. Configure `GROWTH_SCHEDULER_AUDIENCE` to exactly match backend_url and `GROWTH_SCHEDULER_SERVICE_ACCOUNT` to scheduler_service_account. Existing legacy cron routes retain their original guard. These new routes do not accept a Firebase/admin token or a shared secret.

Terraform creates paused jobs by default in America/Merida. First apply to staging, verify manual authenticated execution, duplicate delivery, recovery, no user-content logging, observed Firestore project, and next scheduled execution; enable_jobs is an explicit deployment configuration. No defaults for project/region/backend avoid accidentally targeting the wrong project. Infrastructure has not been applied by this change.

Service account needs Cloud Run Invoker if the service is private; scheduler deployer needs iam.serviceAccounts.actAs. No service-account key is needed. Google Scheduler OIDC documentation: https://docs.cloud.google.com/scheduler/docs/http-target-auth

Enable Firestore TTL only for the safe collections explicitly listed in the index manifest after validating retention. Never apply unconditional TTL to undelivered event_outbox records. Durable operations must be settled/released before TTL deletion; do not blindly TTL-delete active reservations. Input debug-zpl objects use existing 15-day bucket lifecycle. The daily cleanup is bounded and must report backlog instead of claiming full deletion.


## Local validation

Terraform 1.9.8 `fmt`, `init -backend=false` and `validate` passed locally with zero warnings/errors. The provider lock pins Google 6.50.0. These checks create no cloud resources and do not validate IAM or a deployment plan. The GitHub workflow repeats static validation.


`test/growth-emulator.test.ts` refuses to run against any host except 127.0.0.1:8085 and uses only `demo-zplpdf-growth`. With Java21 available, run:

```sh
npx --yes firebase-tools@15.30.1 emulators:exec --only firestore --project demo-zplpdf-growth --config test/firebase-emulator.json 'npx jest --config test/growth-emulator.jest.json --runInBand'
```

The same command is included in Growth synthetic QA. Local validation passed seven domain transaction tests and nine financial transaction tests on 2026-09-17. This does not apply indexes, validate production IAM or attest a deployed service. The emulator does not enforce composite index requirements: deploy the reviewed `firestore.indexes.json` separately to the confirmed target project.


## Retention configuration

The index manifest enables native TTL only on the explicitly listed safe `expiresAt` fields, retaining single-field indexes for bounded cleanup queries. In particular, `drive_revocations` receives an expiry only after provider acknowledgement; pending/failed secrets have no expiry. `label_workflows` and its `labels` collection group each expire independently, avoiding orphan source content after deleting a parent. `api_job_inputs` expires separately from queue/account counters.

Do **not** enable unconditional TTL on `durable_operations`, `api_jobs`, `label_workflow_exports` or `label_template_runs`: settle/release accounting and retain unresolved evidence before deletion. Pending canonical outboxes are not in this TTL manifest. Saved PDF presets and label templates are persistent until archived/deleted by their owner; uploaded sources are temporary.

Field format verified against the [Firebase index definition reference](https://firebase.google.com/docs/reference/firestore/indexes). The manifest has not been deployed; existing project indexes must be merged/reviewed before using Firebase deployment, which can propose removal of unlisted indexes.
