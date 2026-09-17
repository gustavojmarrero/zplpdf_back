import type { LabelSize } from '../zpl/enums/label-size.enum.js';
import type { DiffMask } from './image-diff.js';

export const RENDERER = {
  rendererId: 'labelary-8dpmm',
  rendererVersion: null,
  verification: 'unversioned_provider',
} as const;
export const ARTIFACT_TTL_MS = 15 * 86400000;
export const METADATA_TTL_MS = 90 * 86400000;
export const LEASE_MS = 10 * 60000;
export const MAX_INPUT_BYTES = 128 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const COLLECTIONS = {
  baseline: 'template_regression_baselines',
  run: 'template_regression_runs',
  operation: 'template_regression_operations',
} as const;
export type DiffSettings = {
  masks: DiffMask[];
  channelTolerance: number;
  maxChangedRatio: number;
};
export interface CreateBaseline {
  operationId: string;
  name: string;
  zpl: string;
  labelSize: LabelSize;
  fixtureId?: string;
}
export interface CreateRun {
  operationId: string;
  baselineId: string;
  baselineVersion: number;
  zpl: string;
  labelSize: LabelSize;
  options?: Partial<DiffSettings>;
}
export interface StoredArtifact {
  path: string;
  sha256: string;
}
export interface VisualResult {
  status: 'compared' | 'dimensions_changed';
  passed: boolean;
  width: number;
  height: number;
  candidateWidth: number;
  candidateHeight: number;
  comparedPixels: number | null;
  changedPixels: number | null;
  changedRatio: number | null;
}

export interface Artifact {
  sha256: string;
  url: string | null;
}
interface ResourceView {
  id: string;
  operationId: string;
  version: number;
  labelSize: LabelSize;
  renderer: typeof RENDERER;
  source: Artifact | null;
  image: Artifact | null;
  createdAt: string;
  artifactsExpireAt: string;
  metadataExpireAt: string;
  errorCode: string | null;
}
export interface Baseline extends ResourceView {
  name: string;
  status: 'processing' | 'ready' | 'approved' | 'failed';
  width: number | null;
  height: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalNote: string | null;
  fixtureId: string | null;
  fixtureVersion: 1 | null;
}
export interface Run extends ResourceView {
  status: 'processing' | 'completed' | 'failed';
  baselineId: string;
  baselineVersion: number;
  diffImage: Artifact | null;
  visual: VisualResult | null;
  payload: {
    changed: boolean;
    baselineSha256: string;
    candidateSha256: string;
  } | null;
  options: DiffSettings;
  adoptedBaselineId: string | null;
}
export type ResourceViews = { baseline: Baseline; run: Run };
export type ResourceEnvelope<K extends keyof ResourceViews> = {
  schemaVersion: 1;
} & { [P in K]: ResourceViews[P] };
