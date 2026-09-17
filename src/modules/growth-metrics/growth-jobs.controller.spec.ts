import { GrowthJobsController } from './growth-jobs.controller.js';
describe('growth snapshot read contract', () => {
  const controller = (data?: Record<string, unknown>) =>
    new GrowthJobsController(
      {} as any,
      {
        getClient: () => ({
          collection: () => ({
            doc: () => ({
              get: async () => ({ exists: !!data, data: () => data }),
            }),
          }),
        }),
      } as any,
    );
  it('returns a current schema with explicit absence before the first run', async () => {
    expect(await controller().snapshot()).toMatchObject({
      schemaVersion: 2,
      calculationVersion: 'growth-v2',
      status: 'insufficient_data',
      features: [],
      sourceWatermark: null,
    });
  });
  it('does not make old source data fresh by regenerating the document', async () => {
    expect(
      await controller({
        status: 'observed',
        generatedAt: new Date().toISOString(),
        sourceWatermark: new Date(Date.now() - 48 * 3600000).toISOString(),
      }).snapshot(),
    ).toMatchObject({ status: 'stale' });
  });
  it('rejects invalid and future source times as observed evidence', async () => {
    for (const sourceWatermark of [
      'invalid',
      new Date(Date.now() + 3600000).toISOString(),
    ])
      expect(
        await controller({
          status: 'observed',
          generatedAt: new Date().toISOString(),
          sourceWatermark,
        }).snapshot(),
      ).toMatchObject({ status: 'stale' });
  });
  it('preserves a fresh incomplete snapshot without inventing a watermark', async () => {
    expect(
      await controller({
        status: 'incomplete',
        generatedAt: new Date().toISOString(),
        sourceWatermark: null,
      }).snapshot(),
    ).toMatchObject({ status: 'incomplete', sourceWatermark: null });
  });
});
