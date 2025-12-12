export type PlanType = 'free' | 'pro' | 'enterprise';

export interface PlanLimits {
  maxLabelsPerPdf: number;
  maxPdfsPerMonth: number;
  canDownloadImages: boolean;
}

export interface User {
  id: string;
  email: string;
  displayName?: string;
  plan: PlanType;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  planLimits?: PlanLimits;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_PLAN_LIMITS: Record<'free' | 'pro', PlanLimits> = {
  free: { maxLabelsPerPdf: 100, maxPdfsPerMonth: 100, canDownloadImages: false },
  pro: { maxLabelsPerPdf: 500, maxPdfsPerMonth: 500, canDownloadImages: true },
};
