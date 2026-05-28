export type PlanType = 'free' | 'lite' | 'pro' | 'promax' | 'enterprise';
export type UserRole = 'user' | 'admin';
export type CountrySource = 'ip' | 'stripe' | 'manual';

export interface PlanLimits {
  maxLabelsPerPdf: number;
  maxPdfsPerMonth: number;
  canDownloadImages: boolean;
}

/**
 * Capacidades (features premium) por plan.
 *
 * Capa EXPLÍCITA de features: las reglas de negocio deben consultar estos flags
 * en lugar de comparar contra literales como `plan === 'free'` o `plan !== 'free'`.
 * Esto evita que planes nuevos (ej. Lite) queden accidentalmente clasificados como
 * premium. Lite es "el Free actual pagado": más cuota, pero SIN features premium.
 */
export interface PlanFeatures {
  /** Acceso al historial de conversiones */
  canViewHistory: boolean;
  /** Prioridad alta en la cola de Labelary */
  hasHighPriority: boolean;
  /** Conserva el nombre original del archivo en la descarga */
  preservesOriginalFilename: boolean;
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
  free: { maxLabelsPerPdf: 75, maxPdfsPerMonth: 10, canDownloadImages: false },
  lite: { maxLabelsPerPdf: 100, maxPdfsPerMonth: 25, canDownloadImages: false },
  pro: { maxLabelsPerPdf: 500, maxPdfsPerMonth: 500, canDownloadImages: true },
  promax: { maxLabelsPerPdf: 1000, maxPdfsPerMonth: 1000, canDownloadImages: true },
  enterprise: { maxLabelsPerPdf: 999999, maxPdfsPerMonth: 999999, canDownloadImages: true },
};

/**
 * Features premium por plan. Free y Lite NO desbloquean ninguna feature premium
 * (Lite solo compra más cuota). Pro/Pro Max/Enterprise desbloquean todas.
 */
export const PLAN_FEATURES: Record<PlanType, PlanFeatures> = {
  free: { canViewHistory: false, hasHighPriority: false, preservesOriginalFilename: false },
  lite: { canViewHistory: false, hasHighPriority: false, preservesOriginalFilename: false },
  pro: { canViewHistory: true, hasHighPriority: true, preservesOriginalFilename: true },
  promax: { canViewHistory: true, hasHighPriority: true, preservesOriginalFilename: true },
  enterprise: { canViewHistory: true, hasHighPriority: true, preservesOriginalFilename: true },
};

/** Orden jerárquico de planes (para comparar upgrades/downgrades). */
export const PLAN_ORDER: Record<PlanType, number> = {
  free: 0,
  lite: 1,
  pro: 2,
  promax: 3,
  enterprise: 4,
};
