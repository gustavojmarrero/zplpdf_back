export type PlanType = 'free' | 'pro' | 'enterprise';
export type UserRole = 'user' | 'admin';

export interface PlanLimits {
  maxLabelsPerPdf: number;
  maxPdfsPerMonth: number;
  canDownloadImages: boolean;
}

export interface User {
  id: string;
  email: string;
  displayName?: string;
  emailVerified: boolean;
  plan: PlanType;
  role: UserRole;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  planLimits?: PlanLimits;
  // Campos de simulación de plan (solo para admins)
  simulatedPlan?: PlanType;
  simulationExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_PLAN_LIMITS: Record<PlanType, PlanLimits> = {
  free: { maxLabelsPerPdf: 100, maxPdfsPerMonth: 25, canDownloadImages: false },
  pro: { maxLabelsPerPdf: 500, maxPdfsPerMonth: 500, canDownloadImages: true },
  enterprise: { maxLabelsPerPdf: 999999, maxPdfsPerMonth: 999999, canDownloadImages: true },
};
