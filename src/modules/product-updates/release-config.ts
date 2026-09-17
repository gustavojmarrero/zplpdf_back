import { FEATURE_IDS } from '../product-observability/observability.types.js';
import type { FeatureId } from '../product-observability/observability.types.js';

/**
 * Hoja deliberada del módulo: solo importa constantes de tipos para que la
 * analítica de root pueda validar metadatos de tour sin import circular.
 */

export const TOUR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const MAX_RELEASE_STEPS = 12;
/** Enum cerrado: un entorno inventado no puede colarse como aprobado. */
export const RELEASE_ENVIRONMENTS = [
  'development',
  'test',
  'staging',
  'production',
] as const;
export type ReleaseEnvironment = (typeof RELEASE_ENVIRONMENTS)[number];
/** ISO 8601 en UTC explícito, con milisegundos opcionales. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export interface ReleaseStepConfig {
  stepId: string;
  featureId: FeatureId;
  anchorId: string;
  order: number;
}

export interface ProductUpdatesRelease {
  releaseId: string;
  tourVersion: string;
  manifestVersion: string;
  enabled: boolean;
  environment: ReleaseEnvironment;
  releasedAt: string;
  releasedFeatureIds: FeatureId[];
  steps: ReleaseStepConfig[];
}

export type ReleaseUnavailableReason =
  | 'no_release_configured'
  | 'release_config_invalid'
  | 'release_disabled'
  | 'release_not_yet_published'
  | 'environment_mismatch'
  | 'no_available_features';

/**
 * No es una unión discriminada a propósito: con `strictNullChecks: false` (config
 * del repo) TypeScript no estrecha uniones por un discriminante booleano, así
 * que `result.ok ? result.release : null` no compilaría. `release` es null
 * cuando `ok` es false y `reason` es null cuando es true.
 */
export interface ReleaseConfigResult {
  ok: boolean;
  release: ProductUpdatesRelease | null;
  reason: ReleaseUnavailableReason | null;
}

/**
 * Fecha estricta: solo UTC explícito y solo calendarios reales. `Date.parse`
 * acepta strings ambiguos y "corrige" fechas imposibles (2026-02-31 pasa a
 * marzo), y una fecha de publicación corregida en silencio decidiría mal a quién
 * se invita.
 */
export function parseIsoUtc(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = new Date(parsed).toISOString();
  const expected = value.length === 20 ? `${value.slice(0, 19)}.000Z` : value;
  return normalized === expected ? normalized : null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isId = (value: unknown): boolean =>
  typeof value === 'string' && TOUR_ID_PATTERN.test(value);

const uniqueStrings = (values: string[]): boolean =>
  new Set(values).size === values.length;

function parseSteps(
  raw: unknown,
  releasedFeatureIds: FeatureId[],
): ReleaseStepConfig[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RELEASE_STEPS)
    return null;
  const steps: ReleaseStepConfig[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return null;
    const { stepId, featureId, anchorId, order } = entry;
    if (!isId(stepId) || !isId(anchorId)) return null;
    if (
      typeof featureId !== 'string' ||
      !FEATURE_IDS.includes(featureId as FeatureId) ||
      !releasedFeatureIds.includes(featureId as FeatureId)
    )
      return null;
    if (!Number.isInteger(order) || !Number.isFinite(order as number))
      return null;
    steps.push({
      stepId: stepId as string,
      featureId: featureId as FeatureId,
      anchorId: anchorId as string,
      order: order as number,
    });
  }
  if (!uniqueStrings(steps.map((s) => s.stepId))) return null;
  if (!uniqueStrings(steps.map((s) => String(s.order)))) return null;
  return steps.slice().sort((a, b) => a.order - b.order);
}

/**
 * Sin config no hay novedades que anunciar y una config inválida no se
 * interpreta a medias: en ambos casos el tour no se presenta.
 */
export function parseProductUpdatesRelease(
  raw: string | undefined | null,
): ReleaseConfigResult {
  if (typeof raw !== 'string' || !raw.trim())
    return { ok: false, release: null, reason: 'no_release_configured' };
  const invalid: ReleaseConfigResult = {
    ok: false,
    release: null,
    reason: 'release_config_invalid',
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid;
  }
  if (!isPlainObject(parsed)) return invalid;
  const {
    releaseId,
    tourVersion,
    manifestVersion,
    enabled,
    environment,
    releasedAt,
    releasedFeatureIds,
    steps,
  } = parsed;
  if (!isId(releaseId) || !isId(tourVersion) || !isId(manifestVersion))
    return invalid;
  if (enabled !== undefined && typeof enabled !== 'boolean') return invalid;
  if (
    typeof environment !== 'string' ||
    !RELEASE_ENVIRONMENTS.includes(environment as ReleaseEnvironment)
  )
    return invalid;
  const releasedAtUtc = parseIsoUtc(releasedAt);
  if (!releasedAtUtc) return invalid;
  if (
    !Array.isArray(releasedFeatureIds) ||
    releasedFeatureIds.length < 1 ||
    !releasedFeatureIds.every(
      (id) => typeof id === 'string' && FEATURE_IDS.includes(id as FeatureId),
    ) ||
    !uniqueStrings(releasedFeatureIds as string[])
  )
    return invalid;
  const parsedSteps = parseSteps(steps, releasedFeatureIds as FeatureId[]);
  if (!parsedSteps) return invalid;
  return {
    ok: true,
    reason: null,
    release: {
      releaseId: releaseId as string,
      tourVersion: tourVersion as string,
      manifestVersion: manifestVersion as string,
      // Deshabilitado por defecto: publicar exige decirlo explícitamente.
      enabled: enabled === true,
      environment: environment as ReleaseEnvironment,
      releasedAt: releasedAtUtc,
      releasedFeatureIds: releasedFeatureIds as FeatureId[],
      steps: parsedSteps,
    },
  };
}

/**
 * Aplica además las condiciones que no dependen del formato: aprobación
 * explícita, entorno con despliegue probado y fecha de publicación pasada.
 */
export function loadApprovedRelease(input: {
  raw: string | undefined | null;
  environment: string;
  now: Date;
}): ReleaseConfigResult {
  const parsed = parseProductUpdatesRelease(input.raw);
  if (!parsed.ok) return parsed;
  const release = parsed.release;
  const unavailable = (
    reason: ReleaseUnavailableReason,
  ): ReleaseConfigResult => ({ ok: false, release: null, reason });
  if (!release.enabled) return unavailable('release_disabled');
  if (release.environment !== input.environment)
    return unavailable('environment_mismatch');
  if (Date.parse(release.releasedAt) > input.now.getTime())
    return unavailable('release_not_yet_published');
  return { ok: true, release, reason: null };
}

export const releaseStepIds = (release: ProductUpdatesRelease): string[] =>
  release.steps.map((step) => step.stepId);

/**
 * Para que la analítica descarte identificadores de tour inventados por el
 * cliente sin acoplarse al servicio.
 */
export function isKnownTourMetadata(
  release: ProductUpdatesRelease | null,
  metadata: { releaseId?: string; tourVersion?: string; stepId?: string },
): boolean {
  if (!release) return false;
  if (
    metadata.releaseId !== undefined &&
    metadata.releaseId !== release.releaseId
  )
    return false;
  if (
    metadata.tourVersion !== undefined &&
    metadata.tourVersion !== release.tourVersion
  )
    return false;
  if (
    metadata.stepId !== undefined &&
    !releaseStepIds(release).includes(metadata.stepId)
  )
    return false;
  return true;
}
