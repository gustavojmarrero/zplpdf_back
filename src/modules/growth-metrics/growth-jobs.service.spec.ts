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
