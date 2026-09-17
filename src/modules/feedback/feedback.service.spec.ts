import { FeedbackService } from './feedback.service.js';
function fixture() {
  const rows = new Map<string, any>();
  let tail = Promise.resolve();
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        path: `${name}/${id}`,
        get: async () => ({
          get: (k: string) => rows.get(`${name}/${id}`)?.[k],
        }),
      }),
    }),
    runTransaction: async (fn: any) => {
      const prior = tail;
      let release: () => void;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await fn({
          get: async (r: any) => ({
            ref: r,
            exists: rows.has(r.path),
            data: () => rows.get(r.path),
            get: (k: string) => rows.get(r.path)?.[k],
          }),
          set: (r: any, data: any, options: any) =>
            rows.set(r.path, {
              ...(options?.merge ? rows.get(r.path) : {}),
              ...data,
            }),
          update: (r: any, data: any) =>
            rows.set(r.path, { ...rows.get(r.path), ...data }),
          create: (r: any, data: any) => rows.set(r.path, data),
        });
      } finally {
        release();
      }
    },
  };
  const store = {
    getClient: () => db,
    getLastFeedbackByUser: jest.fn().mockResolvedValue(null),
    getUserById: jest.fn().mockResolvedValue({ plan: 'free' }),
  };
  return { service: new FeedbackService(store as any), rows, store };
}
describe('global survey cadence', () => {
  it('only one concurrent tab can claim an invitation and status suppresses another survey', async () => {
    const f = fixture();
    const outcomes = await Promise.all([
      f.service.claimInvitation('a'),
      f.service.claimInvitation('a'),
    ]);
    expect(outcomes.filter((x) => x.shouldShow)).toHaveLength(1);
    expect((await f.service.getStatus('a')).shouldShow).toBe(false);
    expect((await f.service.claimInvitation('b')).shouldShow).toBe(true);
  });
  it('does not invite a recently surveyed legacy account and rejects deleted accounts', async () => {
    const f = fixture();
    f.store.getLastFeedbackByUser.mockResolvedValue({ createdAt: new Date() });
    expect((await f.service.claimInvitation('a')).shouldShow).toBe(false);
    f.rows.set('deleted_accounts/a', { deletedAt: new Date() });
    await expect(f.service.claimInvitation('a')).rejects.toThrow(
      'Account unavailable',
    );
  });
  it('concurrent submits save one response, with server-owned feature context', async () => {
    const f = fixture();
    f.rows.set('in_app_feedback_candidates/a', {
      featureId: 'packing_workflow',
    });
    await f.service.claimInvitation('a');
    const responses = await Promise.all([
      f.service.submit('a', undefined, { sentiment: 'good' }),
      f.service.submit('a', undefined, { sentiment: 'bad' }),
    ]);
    expect(responses.filter((x) => x.skipped)).toHaveLength(1);
    const saved = [...f.rows.entries()].filter(([path]) =>
      path.startsWith('feedback/'),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0][1].featureId).toBe('packing_workflow');
  });
});
