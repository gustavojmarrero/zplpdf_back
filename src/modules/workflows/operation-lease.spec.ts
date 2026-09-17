import { InMemoryWorkflowRepository } from './workflows.in-memory-repository.js';
import { InMemoryTemplateRepository } from '../label-templates/label-templates.in-memory-repository.js';
import { InMemoryLabelEventOutbox } from './label-event.store.js';
import {
  AccountDeletedError,
  buildOutboxRecord,
} from './label-event.outbox.js';
import {
  MAX_OPERATION_ATTEMPTS,
  OPERATION_RETENTION_MS,
  withOperationLease,
} from './operation-lease.js';
import type { ExportRecord } from './workflows.types.js';
import type { TemplateRunRecord } from '../label-templates/label-templates.types.js';

const id = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-09-17T12:00:00Z');
const base = {
  accountId: 'alice',
  ownerId: 'alice',
  intentHash: 'intent',
  idempotencyKey: 'key',
  status: 'pending' as const,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

function harness(kind: 'export' | 'run') {
  const outbox = new InMemoryLabelEventOutbox();
  const repository =
    kind === 'export'
      ? new InMemoryWorkflowRepository(outbox)
      : new InMemoryTemplateRepository(outbox);
  const candidate: ExportRecord | TemplateRunRecord =
    kind === 'export'
      ? {
          ...base,
          exportId: id,
          workflowId: 'workflow',
          workflowVersion: 1,
          outputFormat: 'pdf',
          labelIds: ['label'],
          labelCount: 1,
          uniqueLabelCount: 1,
        }
      : {
          ...base,
          runId: id,
          templateId: 'template',
          templateVersion: 1,
          format: 'csv',
          labelSize: '4x6',
          outputFormat: 'pdf',
          rowCount: 1,
          validRowCount: 1,
          emptyRowCount: 0,
          invalidRowCount: 0,
          labelCount: 1,
          diagnostics: [],
          sourceChecksum: 'source',
        };
  const event = () =>
    buildOutboxRecord({
      eventName:
        kind === 'export'
          ? 'packing_export_succeeded'
          : 'template_run_succeeded',
      accountId: 'alice',
      featureId: kind === 'export' ? 'packing_workflow' : 'data_templates',
      featureVersion: '1',
      operationId: id,
      source: 'api',
      jobId: id,
      labelCount: 1,
    });
  return {
    outbox,
    repository,
    event,
    reserve: () =>
      repository instanceof InMemoryWorkflowRepository
        ? repository.reserveExport(candidate as ExportRecord, new Date())
        : repository.reserveRun(candidate as TemplateRunRecord, new Date()),
    complete: (token: string, out = event()) =>
      repository instanceof InMemoryWorkflowRepository
        ? repository.completeExport(
            id,
            token,
            {
              jobId: id,
              labelIds: ['label'],
              labelCount: 1,
              uniqueLabelCount: 1,
            },
            out,
          )
        : repository.completeRun(id, token, { jobId: id }, out),
    fail: (token: string) =>
      repository instanceof InMemoryWorkflowRepository
        ? repository.failExport(id, token, 'SERVER_ERROR')
        : repository.failRun(id, token, 'SERVER_ERROR'),
    renew: (token: string) =>
      repository instanceof InMemoryWorkflowRepository
        ? repository.renewExport(id, token)
        : repository.renewRun(id, token),
    get: () =>
      repository instanceof InMemoryWorkflowRepository
        ? repository.getExport('alice', id)
        : repository.getRun('alice', id),
  };
}

describe.each(['export', 'run'] as const)('%s reservation fencing', (kind) => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());

  it('rejects stale completion, failure, and renewal after takeover; only the winner emits a fact', async () => {
    const h = harness(kind);
    const first = await h.reserve();
    expect((await h.reserve()).outcome).toBe('in_progress');
    jest.setSystemTime(new Date(now.getTime() + 13 * 60_000));
    const second = await h.reserve();
    expect(second.record.leaseToken).not.toBe(first.record.leaseToken);
    for (const action of [h.complete, h.fail, h.renew])
      await expect(action(first.record.leaseToken!)).rejects.toMatchObject({
        response: { error: 'OPERATION_LEASE_LOST' },
      });
    expect(await h.get()).toEqual(second.record);
    expect(h.outbox.all()).toHaveLength(0);
    const accepted = await h.complete(second.record.leaseToken!);
    expect(await h.complete(first.record.leaseToken!)).toEqual(accepted);
    expect(await h.fail(first.record.leaseToken!)).toEqual(accepted);
    expect(await h.fail(second.record.leaseToken!)).toEqual(accepted);
    expect(h.outbox.all()).toHaveLength(1);
    expect((await h.get())?.completionEvent?.id).toBe(
      accepted.completionEvent?.id,
    );
  });

  it('does not resurrect an acknowledged outbox event on a late completion', async () => {
    const h = harness(kind);
    const first = await h.reserve();
    const accepted = await h.complete(first.record.leaseToken!);
    const claim = await h.outbox.claimOne(
      accepted.completionEvent!.id,
      new Date(),
    );
    await h.outbox.ack(claim!.record.id, claim!.token);
    await h.complete(first.record.leaseToken!, h.event());
    expect(h.outbox.all()).toHaveLength(0);
    expect((await h.reserve()).record).toEqual(accepted);
  });

  it('recovers death before acceptance and preserves acceptance after death', async () => {
    const h = harness(kind);
    const first = await h.reserve();
    h.repository.failNextCommit();
    await expect(h.complete(first.record.leaseToken!)).rejects.toThrow('crash');
    expect((await h.get())?.status).toBe('pending');
    expect(h.outbox.all()).toHaveLength(0);
    jest.setSystemTime(new Date(now.getTime() + 13 * 60_000));
    const retry = await h.reserve();
    const accepted = await h.complete(retry.record.leaseToken!);
    expect((await h.reserve()).record).toEqual(accepted);
    expect(h.outbox.all()).toHaveLength(1);
  });

  it('cannot revive an expired lease or mutate after account deletion', async () => {
    const h = harness(kind);
    const first = await h.reserve();
    jest.setSystemTime(new Date(now.getTime() + 13 * 60_000));
    await expect(h.renew(first.record.leaseToken!)).rejects.toThrow();
    await expect(h.complete(first.record.leaseToken!)).rejects.toThrow();
    const current = await h.reserve();
    h.repository.markAccountDeleted('alice');
    for (const action of [h.complete, h.fail, h.renew])
      await expect(action(current.record.leaseToken!)).rejects.toBeInstanceOf(
        AccountDeletedError,
      );
    await expect(h.reserve()).rejects.toBeInstanceOf(AccountDeletedError);
    expect(await h.get()).toEqual(current.record);
    expect(h.outbox.all()).toHaveLength(0);
  });

  it('fixes retention at creation and blocks expired replay or reclaim without deleting evidence', async () => {
    const h = harness(kind);
    const first = await h.reserve();
    expect(Date.parse(first.record.expiresAt!)).toBe(
      now.getTime() + OPERATION_RETENTION_MS,
    );
    jest.setSystemTime(new Date(now.getTime() + 13 * 60_000));
    const second = await h.reserve();
    expect(second.record.expiresAt).toBe(first.record.expiresAt);
    const accepted = await h.complete(second.record.leaseToken!);
    jest.setSystemTime(new Date(now.getTime() + OPERATION_RETENTION_MS));
    await expect(h.reserve()).rejects.toMatchObject({
      response: { error: 'OPERATION_EXPIRED' },
    });
    expect(await h.get()).toEqual(accepted);
    expect(h.outbox.all()).toHaveLength(1);
  });

  it('retains expired pending evidence without allowing another converter attempt', async () => {
    const h = harness(kind);
    const first = await h.reserve();
    jest.setSystemTime(new Date(now.getTime() + OPERATION_RETENTION_MS));
    await expect(h.reserve()).rejects.toMatchObject({
      response: { error: 'OPERATION_EXPIRED' },
    });
    await expect(h.renew(first.record.leaseToken!)).rejects.toMatchObject({
      response: { error: 'OPERATION_EXPIRED' },
    });
    expect(await h.get()).toEqual(first.record);
  });

  it('bounds reclaim attempts without changing the last reservation', async () => {
    const h = harness(kind);
    for (let n = 0; n < MAX_OPERATION_ATTEMPTS; n++) {
      const claim = await h.reserve();
      expect(claim.record.attempts).toBe(n + 1);
      jest.setSystemTime(new Date(Date.now() + 13 * 60_000));
    }
    const last = await h.get();
    await expect(h.reserve()).rejects.toMatchObject({
      response: { error: 'OPERATION_ATTEMPTS_EXHAUSTED' },
    });
    expect(await h.get()).toEqual(last);
  });

  it('renews through a conversion longer than both original leases and stops its timer', async () => {
    const h = harness(kind);
    const claim = await h.reserve();
    let finish!: () => void;
    const work = withOperationLease(
      () => h.renew(claim.record.leaseToken!),
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await jest.advanceTimersByTimeAsync(15 * 60_000);
    expect((await h.reserve()).outcome).toBe('in_progress');
    finish();
    await work;
    expect(jest.getTimerCount()).toBe(0);
    expect((await h.complete(claim.record.leaseToken!)).status).toBe(
      'accepted',
    );
  });
});
