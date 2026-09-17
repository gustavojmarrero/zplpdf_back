import { TOUR_EVENTS } from '../product-observability/observability.types.js';
import type { CohortEvent } from './cohort-metrics.js';

type TourFact = CohortEvent & {
  source?: string;
  releaseId?: string;
  tourVersion?: string;
  consent?: { analytics: boolean };
};
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;

/** Consented, descriptive tour activity. No account identifiers leave this function. */
export function summarizeTourEvents(
  events: TourFact[],
  window: { start: string; end: string },
  complete: boolean,
) {
  const groups = new Map<string, Map<string, Set<string>>>();
  for (const event of events) {
    if (
      event.isSynthetic ||
      event.source !== 'web' ||
      event.consent?.analytics !== true ||
      !TOUR_EVENTS.includes(event.eventName as (typeof TOUR_EVENTS)[number]) ||
      !ID.test(event.releaseId ?? '') ||
      !ID.test(event.tourVersion ?? '') ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      Date.parse(event.occurredAt) < Date.parse(window.start) ||
      Date.parse(event.occurredAt) > Date.parse(window.end)
    )
      continue;
    const key = JSON.stringify([event.releaseId, event.tourVersion]);
    const group = groups.get(key) ?? new Map<string, Set<string>>();
    const accounts = group.get(event.eventName) ?? new Set<string>();
    accounts.add(event.accountId);
    group.set(event.eventName, accounts);
    groups.set(key, group);
  }
  return {
    status: !complete
      ? 'incomplete'
      : groups.size
        ? 'observed'
        : 'insufficient_data',
    reason: !complete
      ? 'coverage_incomplete'
      : 'consented_activity_not_activation_or_payment',
    population: 'observed_analytics_consent_only',
    window,
    releases: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, group]) => {
        const [releaseId, tourVersion] = JSON.parse(key) as [string, string];
        const started = group.get('tour_started') ?? new Set<string>();
        const finished = group.get('tour_completed') ?? new Set<string>();
        const completedAmongStarted = [...started].filter((id) =>
          finished.has(id),
        ).length;
        return {
          releaseId,
          tourVersion,
          observedInvitedAccounts:
            group.get('tour_invitation_viewed')?.size ?? 0,
          startedAccounts: started.size,
          completedAccounts: finished.size,
          dismissedAccounts: group.get('tour_dismissed')?.size ?? 0,
          featureOpenedAccounts: group.get('tour_feature_opened')?.size ?? 0,
          upgradeClickedAccounts: group.get('tour_upgrade_clicked')?.size ?? 0,
          completionAmongObservedStarts: {
            numerator: completedAmongStarted,
            denominator: started.size,
            value:
              complete && started.size
                ? completedAmongStarted / started.size
                : null,
          },
        };
      }),
  };
}
