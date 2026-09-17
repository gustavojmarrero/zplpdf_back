import { ConfigService } from '@nestjs/config';
import { FirestoreService } from '../cache/firestore.service.js';
import { ProductEventOutboxService } from '../product-observability/product-event-outbox.service.js';
import { GrowthJobsService } from './growth-jobs.service.js';
describe('growth scheduler retry boundary', () => {
  let data: Record<string, any>;
  let dispatch: jest.Mock;
  let service: GrowthJobsService;
  beforeEach(() => {
    data = {};
    dispatch = jest
      .fn()
      .mockResolvedValue({ scanned: 0, delivered: 0, failed: 0 });
    const db = {
      collection: () => ({ doc: (id: string) => id }),
      runTransaction: async (fn: any) =>
        fn({
          get: async (id: string) => ({
            data: () => data[id],
            get: (key: string) => data[id]?.[key],
          }),
          set: (id: string, value: any) => {
            data[id] = { ...data[id], ...value };
          },
          update: (id: string, value: any) => {
            data[id] = { ...data[id], ...value };
          },
        }),
    };
    service = new GrowthJobsService(
      { getClient: () => db } as unknown as FirestoreService,
      { dispatch } as unknown as ProductEventOutboxService,
      new ConfigService(),
      { run: jest.fn() } as any,
    );
  });
  it('does not execute a completed scheduler window twice', async () => {
    const first = await service.run('outbox');
    const second = await service.run('outbox');
    expect(first.status).toBe('completed');
    expect(second.status).toBe('already_claimed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('records safe failure and allows a retry of the same window', async () => {
    dispatch.mockRejectedValueOnce(new Error('secret payload'));
    await expect(service.run('outbox')).rejects.toThrow('Growth job failed');
    expect(JSON.stringify(data)).not.toContain('secret payload');
    expect(Object.values(data)[0]).toMatchObject({
      status: 'failed',
      leaseUntil: 0,
    });
    expect((await service.run('outbox')).status).toBe('completed');
    expect(Object.values(data)[0].attempts).toBe(2);
  });
  it('does not overwrite a newer lease owner on stale completion', async () => {
    dispatch.mockImplementation(async () => {
      Object.values(data)[0].token = 'new-owner';
      return {};
    });
    await expect(service.run('outbox')).rejects.toThrow('Growth job failed');
    expect(Object.values(data)[0].status).toBe('running');
  });
});

describe('feedback invitations require real feature use', () => {
  it('ignores tour completion and selects a server-confirmed conversion', async () => {
    const writes: Array<{ accountId: string }> = [];
    const facts = [
      { accountId: 'tour-only', eventName: 'tour_completed', source: 'web' },
      {
        accountId: 'forged-web',
        eventName: 'packing_export_succeeded',
        source: 'web',
      },
      {
        accountId: 'converter',
        eventName: 'packing_export_succeeded',
        source: 'api',
      },
    ].map((event) => ({
      ...event,
      environment: 'test',
      isSynthetic: false,
      featureId: 'packing_workflow',
    }));
    const db = {
      collection: (name: string) => {
        const query = {
          where: () => query,
          limit: () => query,
          get: async () => ({
            size: name === 'growth_event_facts' ? facts.length : 0,
            docs:
              name === 'growth_event_facts'
                ? facts.map((event) => ({ data: () => event }))
                : [],
          }),
          doc: (id: string) => ({ name, id }),
        };
        return query;
      },
      runTransaction: async (callback: any) =>
        callback({
          get: async () => ({ exists: false, get: () => undefined }),
          set: (_ref: unknown, value: { accountId: string }) =>
            writes.push(value),
        }),
    };
    const lastFeedback = jest.fn().mockResolvedValue(null);
    const service = new GrowthJobsService(
      {
        getClient: () => db,
        getLastFeedbackByUser: lastFeedback,
      } as unknown as FirestoreService,
      {} as ProductEventOutboxService,
      new ConfigService({ PRODUCT_ENVIRONMENT: 'test' }),
      {} as any,
    );
    const result = await (service as any).prepareFeedbackCandidates();
    expect(result.created).toBe(1);
    expect(writes.map((row) => row.accountId)).toEqual(['converter']);
    expect(lastFeedback).toHaveBeenCalledTimes(1);
    expect(lastFeedback).toHaveBeenCalledWith('converter');
  });
});
