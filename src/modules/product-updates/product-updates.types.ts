import { createHash } from 'node:crypto';
import type { FeatureId } from '../product-observability/observability.types.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';

export const PRODUCT_TOUR_PROGRESS_COLLECTION = 'product_tour_progress';
/** Ventana acotada de idempotencia: el documento no crece sin límite. */
export const APPLIED_EVENT_WINDOW = 50;
export const TERMINAL_HISTORY_MAX = 20;

export const TOUR_STATES = [
  'pending',
  'started',
  'closed',
  'skipped',
  'completed',
] as const;
export type TourState = (typeof TOUR_STATES)[number];

/** Monotonía: ninguna acción distinta de `replay` baja de rango. */
export const TOUR_STATE_RANK: Record<TourState, number> = {
  pending: 0,
  started: 1,
  closed: 2,
  skipped: 3,
  completed: 4,
};
export const TERMINAL_TOUR_STATES: TourState[] = ['skipped', 'completed'];

export const TOUR_ACTIONS = [
  'start',
  'view_step',
  'close',
  'skip',
  'complete',
  'replay',
] as const;
export type TourAction = (typeof TOUR_ACTIONS)[number];

/**
 * Enum acordado con el frontend: la config del servidor solo nombra features,
 * nunca URLs, así una config manipulada no puede inyectar destinos. El frontend
 * mapea cada clave a su ruta.
 */
export const CANONICAL_ROUTE_KEYS = {
  packing_workflow: 'workflows',
  data_templates: 'templates',
  pdf_preparation: 'pdf',
  folder_automation: 'integrations',
  direct_print: 'printing',
  template_regression: 'regression',
  self_service_api: 'api',
} as const satisfies Record<FeatureId, string>;
export type CanonicalRouteKey =
  (typeof CANONICAL_ROUTE_KEYS)[keyof typeof CANONICAL_ROUTE_KEYS];

export const PRODUCT_UPDATES_ENTRY_LABEL_KEY = 'productUpdates.entry';
export const releaseTitleKey = (releaseId: string) =>
  `productUpdates.${releaseId}.title`;
export const releaseSummaryKey = (releaseId: string) =>
  `productUpdates.${releaseId}.summary`;
export const stepTitleKey = (releaseId: string, stepId: string) =>
  `productUpdates.${releaseId}.steps.${stepId}.title`;
export const stepBodyKey = (releaseId: string, stepId: string) =>
  `productUpdates.${releaseId}.steps.${stepId}.body`;
export const upgradeTitleKey = (featureId: FeatureId) =>
  `productUpdates.upgrade.${featureId}.title`;
export const upgradeBodyKey = (featureId: FeatureId) =>
  `productUpdates.upgrade.${featureId}.body`;

export interface ProductTourStep {
  stepId: string;
  featureId: FeatureId;
  featureVersion: string;
  order: number;
  anchorId: string;
  titleKey: string;
  bodyKey: string;
  action: { kind: 'navigate'; routeKey: CanonicalRouteKey };
}

export interface UpgradeNotice {
  featureId: FeatureId;
  featureVersion: string;
  minimumPlan: PlanType;
  titleKey: string;
  bodyKey: string;
  /** Información honesta: nunca navegación a un espacio de trabajo prohibido. */
  action: { kind: 'upgrade_info' };
}

export interface ProductUpdatesReleaseView {
  releaseId: string;
  tourVersion: string;
  manifestVersion: string;
  environment: string;
  releasedAt: string;
  titleKey: string;
  summaryKey: string;
  steps: ProductTourStep[];
  upgrades: UpgradeNotice[];
}

export interface ProductTourProgressView {
  releaseId: string;
  tourVersion: string;
  state: TourState;
  /**
   * Terminal y monótono: omitir o completar lo fijan y repetir nunca lo limpia,
   * así repetir abre sesión sin restablecer la invitación automática.
   */
  invitationSuppressed: boolean;
  revision: number;
  visitedStepIds: string[];
  lastStepId: string | null;
  replays: number;
  startedAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  skippedAt: string | null;
  completedAt: string | null;
}

export type InvitationReason =
  | 'registered_before_release'
  | 'resume_available'
  | 'invitation_suppressed'
  | 'registered_after_release'
  | 'registration_unknown'
  | 'already_skipped'
  | 'already_completed'
  | 'no_release'
  | 'no_available_features'
  | 'progress_unavailable';

export interface ProductUpdatesResponse {
  schemaVersion: 1;
  plan: PlanType;
  entry: { available: true; labelKey: typeof PRODUCT_UPDATES_ENTRY_LABEL_KEY };
  release: ProductUpdatesReleaseView | null;
  invitation: { shouldInvite: boolean; reason: InvitationReason };
  progress: ProductTourProgressView | null;
  unavailableReason?: string;
}

export interface TourProgressResult {
  schemaVersion: 1;
  applied: boolean;
  duplicate: boolean;
  progress: ProductTourProgressView;
}

/**
 * Entrada de la ventana de idempotencia: el `eventId` por sí solo no basta, hay
 * que reconocer si el reintento trae el mismo cuerpo.
 */
export interface AppliedTourEvent {
  eventId: string;
  fingerprint: string;
}

/** Documento persistido. Sin texto libre, sin contenido de etiquetas. */
export interface TourProgressRecord {
  schemaVersion: 1;
  accountId: string;
  releaseId: string;
  tourVersion: string;
  state: TourState;
  invitationSuppressed: boolean;
  revision: number;
  visitedStepIds: string[];
  lastStepId: string | null;
  replays: number;
  terminalHistory: { state: TourState; at: string }[];
  appliedEvents: AppliedTourEvent[];
  startedAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  skippedAt: string | null;
  completedAt: string | null;
}

/**
 * Hash del triplete, no concatenación: un uid puede traer barras o los mismos
 * separadores y dos identidades distintas no pueden colisionar en el mismo
 * documento. `accountId` sigue como campo para el borrado por cuenta.
 */
export const progressDocId = (
  accountId: string,
  releaseId: string,
  tourVersion: string,
) =>
  createHash('sha256')
    .update(JSON.stringify([accountId, releaseId, tourVersion]))
    .digest('hex');

/**
 * Huella del cuerpo aceptado: el mismo `eventId` con otra acción, otro paso u
 * otra revisión esperada no puede confirmarse como duplicado silencioso.
 */
export const tourEventFingerprint = (command: {
  action: TourAction;
  stepId?: string;
  expectedRevision: number;
}) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        command.action,
        command.stepId ?? null,
        command.expectedRevision,
      ]),
    )
    .digest('hex');

export const emptyProgress = (
  accountId: string,
  releaseId: string,
  tourVersion: string,
): TourProgressRecord => ({
  schemaVersion: 1,
  accountId,
  releaseId,
  tourVersion,
  state: 'pending',
  invitationSuppressed: false,
  revision: 0,
  visitedStepIds: [],
  lastStepId: null,
  replays: 0,
  terminalHistory: [],
  appliedEvents: [],
  startedAt: null,
  updatedAt: null,
  closedAt: null,
  skippedAt: null,
  completedAt: null,
});

export const toProgressView = (
  record: TourProgressRecord,
): ProductTourProgressView => ({
  releaseId: record.releaseId,
  tourVersion: record.tourVersion,
  state: record.state,
  invitationSuppressed: record.invitationSuppressed,
  revision: record.revision,
  visitedStepIds: record.visitedStepIds.slice(),
  lastStepId: record.lastStepId,
  replays: record.replays,
  startedAt: record.startedAt,
  updatedAt: record.updatedAt,
  closedAt: record.closedAt,
  skippedAt: record.skippedAt,
  completedAt: record.completedAt,
});

/** Anonymous, read-only pricing catalog. Contains no account or rollout metadata. */
export interface PublicProductCatalog {
  schemaVersion: 1;
  releaseId: string | null;
  manifestVersion: string | null;
  features: { featureId: FeatureId; minimumPlan: PlanType }[];
}
