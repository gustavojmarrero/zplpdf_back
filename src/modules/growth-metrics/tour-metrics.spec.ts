import { summarizeTourEvents } from './tour-metrics.js';
import { calculateFeatureCohorts } from './cohort-metrics.js';

const window = { start: '2026-09-01T00:00:00Z', end: '2026-09-30T00:00:00Z' };
const event = (eventName: string, accountId = 'private-user') => ({
  eventName,
  accountId,
  featureId: 'packing_workflow',
  occurredAt: '2026-09-10T00:00:00Z',
  source: 'web',
  releaseId: 'growth-2026',
  tourVersion: '1',
  consent: { analytics: true },
});

describe('Consented tour metrics', () => {
  it('counts accounts once across steps and never treats clicks/completion as activation', () => {
    const events = [
      event('tour_started'),
      event('tour_started'),
      event('tour_completed'),
      event('tour_completed', 'earlier-start'),
      event('tour_upgrade_clicked'),
    ];
    const result = summarizeTourEvents(events, window, true);
    expect(result.releases[0]).toMatchObject({
      startedAccounts: 1,
      completedAccounts: 2,
      upgradeClickedAccounts: 1,
      completionAmongObservedStarts: { numerator: 1, denominator: 1, value: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-user|earlier-start/);
    expect(
      calculateFeatureCohorts(
        [event('feature_exposed'), ...events],
        'packing_workflow',
        window.end,
      ),
    ).toMatchObject({ activation7d: { numerator: 0 } });
  });

  it('excludes unconsented, synthetic, invalid and out-of-window events', () => {
    const rows = [
      { ...event('tour_started'), consent: { analytics: false } },
      { ...event('tour_started'), isSynthetic: true },
      { ...event('tour_started'), occurredAt: '2025-01-01T00:00:00Z' },
      { ...event('tour_started'), releaseId: 'person@example.test' },
    ];
    expect(summarizeTourEvents(rows, window, true)).toMatchObject({
      status: 'insufficient_data',
      releases: [],
    });
  });

  it('does not fabricate a completion rate with missing starts or incomplete coverage', () => {
    expect(
      summarizeTourEvents([event('tour_completed')], window, true).releases[0]
        .completionAmongObservedStarts.value,
    ).toBeNull();
    const result = summarizeTourEvents(
      [event('tour_started'), event('tour_completed')],
      window,
      false,
    );
    expect(result.status).toBe('incomplete');
    expect(result.releases[0].completionAmongObservedStarts.value).toBeNull();
  });
});
