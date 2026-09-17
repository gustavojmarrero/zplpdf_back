import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isKnownTourMetadata,
  loadApprovedRelease,
  parseIsoUtc,
  parseProductUpdatesRelease,
  releaseStepIds,
} from './release-config.js';

const base = {
  releaseId: 'growth-2026-09',
  tourVersion: '1',
  manifestVersion: '1',
  enabled: true,
  environment: 'production',
  releasedAt: '2026-09-01T00:00:00.000Z',
  releasedFeatureIds: ['packing_workflow', 'data_templates'],
  steps: [
    {
      stepId: 'templates_intro',
      featureId: 'data_templates',
      anchorId: 'nav-templates',
      order: 2,
    },
    {
      stepId: 'packing_intro',
      featureId: 'packing_workflow',
      anchorId: 'nav-packing',
      order: 1,
    },
  ],
};
const raw = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...base, ...overrides });

describe('product updates release config', () => {
  it('accepts an approved release and orders steps by declared order', () => {
    const result = parseProductUpdatesRelease(raw());
    expect(result.ok).toBe(true);
    expect(releaseStepIds(result.release)).toEqual([
      'packing_intro',
      'templates_intro',
    ]);
    expect(result.reason).toBeNull();
  });

  it('reports absence and invalid shapes apart, and never announces either', () => {
    expect(parseProductUpdatesRelease(undefined)).toEqual({
      ok: false,
      release: null,
      reason: 'no_release_configured',
    });
    expect(parseProductUpdatesRelease('   ').reason).toBe(
      'no_release_configured',
    );
    for (const value of [
      '{not json',
      '[]',
      'null',
      '"text"',
      raw({ releaseId: 'Growth 2026' }),
      raw({ tourVersion: '' }),
      raw({ manifestVersion: 'a'.repeat(41) }),
      raw({ enabled: 'yes' }),
      raw({ environment: '  ' }),
      raw({ environment: 42 }),
      // Fuera del enum cerrado de entornos: no se interpreta como aprobado.
      raw({ environment: 'prod' }),
      raw({ environment: 'PRODUCTION' }),
      raw({ releasedAt: 'not-a-date' }),
      // Fecha de publicación: solo ISO en UTC explícito y calendario real.
      raw({ releasedAt: '2026-09-01' }),
      raw({ releasedAt: '2026-09-01T00:00:00' }),
      raw({ releasedAt: '2026-09-01T00:00:00+02:00' }),
      raw({ releasedAt: '2026-09-01T00:00:00.000+00:00' }),
      raw({ releasedAt: '2026-02-31T00:00:00.000Z' }),
      raw({ releasedAt: '2026-13-01T00:00:00.000Z' }),
      raw({ releasedAt: '2026-09-01T25:00:00.000Z' }),
      raw({ releasedAt: 'September 1, 2026 UTC' }),
      raw({ releasedFeatureIds: [] }),
      raw({ releasedFeatureIds: ['packing_workflow', 'packing_workflow'] }),
      raw({ releasedFeatureIds: ['does_not_exist'] }),
      raw({ steps: [] }),
      raw({
        // El paso apunta a una feature que el release no declara liberada.
        steps: [
          {
            stepId: 'api_intro',
            featureId: 'self_service_api',
            anchorId: 'nav-api',
            order: 1,
          },
        ],
      }),
      raw({
        steps: [
          { ...base.steps[1], stepId: 'dup', order: 1 },
          { ...base.steps[0], stepId: 'dup', order: 2 },
        ],
      }),
      raw({
        steps: [
          { ...base.steps[1], order: 1 },
          { ...base.steps[0], order: 1 },
        ],
      }),
      raw({ steps: [{ ...base.steps[1], order: 1.5 }] }),
      raw({ steps: [{ ...base.steps[1], anchorId: 'Nav Packing' }] }),
      raw({
        steps: Array.from({ length: 13 }, (_, i) => ({
          stepId: `step-${i}`,
          featureId: 'packing_workflow',
          anchorId: `anchor-${i}`,
          order: i,
        })),
      }),
    ]) {
      const result = parseProductUpdatesRelease(value);
      expect(result.ok).toBe(false);
      expect(result.release).toBeNull();
      expect(result.reason).toBe('release_config_invalid');
    }
  });

  it('accepts a release date only as explicit UTC and normalises it', () => {
    const withSeconds = parseProductUpdatesRelease(
      raw({ releasedAt: '2026-09-01T00:00:00Z' }),
    );
    expect(withSeconds.ok).toBe(true);
    expect(withSeconds.release.releasedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(
      parseProductUpdatesRelease(
        raw({ releasedAt: '2026-09-01T12:30:45.123Z' }),
      ).release.releasedAt,
    ).toBe('2026-09-01T12:30:45.123Z');
    // 2026-02-31 existe para Date.parse (rueda a marzo) y no puede colarse.
    expect(parseIsoUtc('2026-02-31T00:00:00.000Z')).toBeNull();
    expect(parseIsoUtc('2026-03-03T00:00:00.000Z')).toBe(
      '2026-03-03T00:00:00.000Z',
    );
  });

  it('keeps the tour disabled unless approval is explicit', () => {
    const parsed = parseProductUpdatesRelease(
      JSON.stringify({ ...base, enabled: undefined }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.release.enabled).toBe(false);
    expect(
      loadApprovedRelease({
        raw: JSON.stringify({ ...base, enabled: undefined }),
        environment: 'production',
        now: new Date('2026-09-18T00:00:00.000Z'),
      }).reason,
    ).toBe('release_disabled');
  });

  it('requires the environment where deployment was proven and a past release date', () => {
    const now = new Date('2026-09-18T00:00:00.000Z');
    expect(
      loadApprovedRelease({ raw: raw(), environment: 'staging', now }).reason,
    ).toBe('environment_mismatch');
    expect(
      loadApprovedRelease({
        raw: raw({ releasedAt: '2026-12-01T00:00:00.000Z' }),
        environment: 'production',
        now,
      }).reason,
    ).toBe('release_not_yet_published');
    const approved = loadApprovedRelease({
      raw: raw(),
      environment: 'production',
      now,
    });
    expect(approved.ok).toBe(true);
    expect(approved.release.environment).toBe('production');
  });

  it('keeps the documented release template valid and still disabled', () => {
    // El template que ops copiará no puede desviarse del contrato en silencio.
    const template = readFileSync(
      join(process.cwd(), 'docs/growth/product-updates-release.disabled.json'),
      'utf8',
    );
    const parsed = parseProductUpdatesRelease(template);
    expect(parsed.ok).toBe(true);
    expect(parsed.release.enabled).toBe(false);
    expect(
      loadApprovedRelease({
        raw: template,
        environment: parsed.release.environment,
        now: new Date('2026-09-18T00:00:00.000Z'),
      }).reason,
    ).toBe('release_disabled');
    const enabled = loadApprovedRelease({
      raw: JSON.stringify({ ...JSON.parse(template), enabled: true }),
      environment: parsed.release.environment,
      now: new Date('2026-09-18T00:00:00.000Z'),
    });
    expect(enabled.ok).toBe(true);
    expect(releaseStepIds(enabled.release)).toHaveLength(7);
  });

  it('validates client supplied tour metadata against the approved release', () => {
    const release = parseProductUpdatesRelease(raw()).release;
    expect(isKnownTourMetadata(release, {})).toBe(true);
    expect(
      isKnownTourMetadata(release, {
        releaseId: 'growth-2026-09',
        tourVersion: '1',
        stepId: 'packing_intro',
      }),
    ).toBe(true);
    expect(isKnownTourMetadata(release, { releaseId: 'other' })).toBe(false);
    expect(isKnownTourMetadata(release, { tourVersion: '2' })).toBe(false);
    expect(isKnownTourMetadata(release, { stepId: 'invented' })).toBe(false);
    // Sin release aprobado nada es conocido: no se acepta metadata de tour.
    expect(isKnownTourMetadata(null, { releaseId: 'growth-2026-09' })).toBe(
      false,
    );
  });
});
