import type { PlanType } from '../../common/interfaces/user.interface.js';
import { PLAN_ORDER } from '../../common/interfaces/user.interface.js';
import type { FeatureId } from './observability.types.js';

/** Commercial access approved on 2026-09-18; rollout may narrow, never expand it. */
export const FEATURE_MINIMUM_PLANS = {
  packing_workflow: 'pro',
  data_templates: 'pro',
  pdf_preparation: 'pro',
  folder_automation: 'promax',
  direct_print: 'promax',
  template_regression: 'promax',
  self_service_api: 'enterprise',
} as const satisfies Record<FeatureId, PlanType>;

export function isFeatureEntitled(
  plan: PlanType,
  featureId: FeatureId,
): boolean {
  return PLAN_ORDER[plan] >= PLAN_ORDER[FEATURE_MINIMUM_PLANS[featureId]];
}
