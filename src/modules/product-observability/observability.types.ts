import type { PlanType } from '../../common/interfaces/user.interface.js';

export const FEATURE_IDS = [
  'packing_workflow',
  'data_templates',
  'self_service_api',
  'pdf_preparation',
  'folder_automation',
  'direct_print',
  'template_regression',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
export const WEB_EVENTS = ['feature_exposed', 'feature_interacted'] as const;
export const ACTIONS = ['open', 'start', 'cancel', 'help', 'retry'] as const;
export const SERVER_EVENTS = [
  'packing_export_succeeded',
  'packing_reexport_succeeded',
  'packing_reconcile_completed',
  'template_run_succeeded',
  'template_saved',
  'api_job_succeeded',
  'pdf_preparation_export_succeeded',
  'folder_run_succeeded',
  'print_job_acknowledged',
  'print_confirmed',
  'regression_run_completed',
  'baseline_approved',
] as const;
export const SURFACES = [
  'dashboard',
  'editor',
  'history',
  'admin',
  'workspace',
  'navigation',
  'feature_page',
  'onboarding',
  'tour',
] as const;
export const CONSENT_VERSION = '2026-09-17';
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const PLANS: PlanType[] = [
  'free',
  'lite',
  'pro',
  'promax',
  'enterprise',
];

export interface ServerEventInput {
  eventId: string;
  schemaVersion: 1;
  eventName: (typeof SERVER_EVENTS)[number];
  accountId: string;
  featureId: FeatureId;
  featureVersion: string;
  operationId: string;
  occurredAt: string;
  source: 'api' | 'folder' | 'print';
  workflowId?: string;
  jobId?: string;
  durationMs?: number;
  labelCount?: number;
  isSynthetic?: boolean;
}

export interface ProductEvent {
  eventId: string;
  schemaVersion: 1;
  eventName: string;
  accountId: string;
  featureId: FeatureId;
  featureVersion: string;
  occurredAt: string;
  receivedAt: string;
  planAtEvent: PlanType;
  source: 'web' | 'api' | 'folder' | 'print';
  environment: 'development' | 'test' | 'staging' | 'production';
  isSynthetic: boolean;
  operationId?: string;
  workflowId?: string;
  jobId?: string;
  surface?: (typeof SURFACES)[number];
  sentAt?: string;
  consentEpoch?: string;
  sessionEpoch?: string;
  action?: (typeof ACTIONS)[number];
  durationMs?: number;
  labelCount?: number;
  consent?: { analytics: true; version: typeof CONSENT_VERSION };
  experimentId?: string;
  assignmentVersion?: string;
  variant?: 'control' | 'treatment';
}
