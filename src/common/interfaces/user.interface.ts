export type PlanType = 'free' | 'pro' | 'promax' | 'enterprise';
export type UserRole = 'user' | 'admin';
export type CountrySource = 'ip' | 'stripe' | 'manual';

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
  // Período de facturación (sincronizado desde Stripe webhooks)
  subscriptionPeriodStart?: Date;
  subscriptionPeriodEnd?: Date;
  planLimits?: PlanLimits;
  // Campos de simulación de plan (solo para admins)
  simulatedPlan?: PlanType;
  simulationExpiresAt?: Date;
  // Campos de geolocalización
  country?: string; // Código ISO 3166-1 alpha-2 (MX, US, ES, etc.)
  city?: string;
  countrySource?: CountrySource;
  countryDetectedAt?: Date;
  // Campos de actividad e inactividad (para GA4)
  lastActivityAt?: Date;
  notifiedInactive7Days?: boolean;
  notifiedInactive30Days?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_PLAN_LIMITS: Record<PlanType, PlanLimits> = {
  free: { maxLabelsPerPdf: 100, maxPdfsPerMonth: 25, canDownloadImages: false },
  pro: { maxLabelsPerPdf: 500, maxPdfsPerMonth: 500, canDownloadImages: true },
  promax: { maxLabelsPerPdf: 1000, maxPdfsPerMonth: 1000, canDownloadImages: true },
  enterprise: { maxLabelsPerPdf: 999999, maxPdfsPerMonth: 999999, canDownloadImages: true },
};
