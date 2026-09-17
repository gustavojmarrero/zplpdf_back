import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { FirestoreService } from '../cache/firestore.service.js';
import type { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { FEATURE_IDS } from '../product-observability/observability.types.js';
import type { FeatureId } from '../product-observability/observability.types.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';
import { ProductUpdatesService } from './product-updates.service.js';
import { TourProgressRepository } from './tour-progress.repository.js';
import {
  PRODUCT_TOUR_PROGRESS_COLLECTION,
  progressDocId,
} from './product-updates.types.js';

/**
 * Firestore en memoria con el contrato que usa el repositorio: lecturas antes
 * de escrituras dentro de `runTransaction`.
 */
class FakeFirestore {
  readonly docs = new Map<string, Record<string, any>>();
  private snapshot(path: string) {
    const value = this.docs.get(path);
    return {
      exists: value !== undefined,
      data: () => value,
      get: (field: string) => value?.[field],
    };
  }
  collection(name: string) {
    return {
      doc: (id: string) => ({
        path: `${name}/${id}`,
        get: async () => this.snapshot(`${name}/${id}`),
      }),
    };
  }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const writes: (() => void)[] = [];
    let readsClosed = false;
    const tx = {
      get: async (ref: { path: string }) => {
        if (readsClosed)
          throw new Error('Firestore requires all reads before writes');
        return this.snapshot(ref.path);
      },
      set: (ref: { path: string }, value: Record<string, any>) => {
        readsClosed = true;
        writes.push(() =>
          this.docs.set(ref.path, JSON.parse(JSON.stringify(value))),
        );
      },
      delete: (ref: { path: string }) => {
        readsClosed = true;
        writes.push(() => this.docs.delete(ref.path));
      },
    };
    const result = await fn(tx);
    for (const write of writes) write();
    return result;
  }
}

const RELEASE = {
  releaseId: 'growth-2026-09',
  tourVersion: '1',
  manifestVersion: '1',
  enabled: true,
  environment: 'production',
  releasedAt: '2026-09-01T00:00:00.000Z',
  releasedFeatureIds: ['packing_workflow', 'data_templates'],
  steps: [
    {
      stepId: 'packing_intro',
      featureId: 'packing_workflow',
      anchorId: 'nav-packing',
      order: 1,
    },
    {
      stepId: 'templates_intro',
      featureId: 'data_templates',
      anchorId: 'nav-templates',
      order: 2,
    },
  ],
};

interface FeatureState {
  featureId: FeatureId;
  featureVersion: string;
  available: boolean;
  eligible: boolean;
  entitled: boolean;
  released: boolean;
  minimumPlan: PlanType;
}

const features = (
  overrides: Partial<Record<FeatureId, Partial<FeatureState>>>,
): FeatureState[] =>
  FEATURE_IDS.map((featureId) => ({
    featureId,
    featureVersion: '1',
    available: false,
    eligible: false,
    entitled: false,
    released: false,
    minimumPlan: 'pro' as PlanType,
    ...(overrides[featureId] ?? {}),
  }));

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const setup = (
  options: {
    raw?: unknown;
    plan?: PlanType;
    featureStates?: FeatureState[];
    createdAt?: unknown;
    environment?: string;
  } = {},
) => {
  const db = new FakeFirestore();
  const env: Record<string, string> = {
    PRODUCT_ENVIRONMENT: options.environment ?? 'production',
  };
  if (options.raw !== undefined)
    env.PRODUCT_UPDATES_RELEASE =
      typeof options.raw === 'string'
        ? options.raw
        : JSON.stringify(options.raw);
  const plan = options.plan ?? 'pro';
  const flags = {
    getFeatures: jest.fn(async () => ({
      schemaVersion: 1,
      plan,
      features:
        options.featureStates ??
        features({
          packing_workflow: { available: true, eligible: true, entitled: true },
          data_templates: { available: true, eligible: true, entitled: true },
        }),
    })),
    account: jest.fn(async () => ({ plan, isSynthetic: false })),
  } as unknown as FeatureFlagsService;
  const users = {
    getUserById: jest.fn(async () => ({
      id: 'acct-1',
      plan,
      createdAt:
        options.createdAt === undefined
          ? new Date('2026-08-01T00:00:00.000Z')
          : options.createdAt,
    })),
  } as unknown as FirestoreService;
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  const repository = new TourProgressRepository(db as any);
  const service = new ProductUpdatesService(flags, users, config, repository);
  return { service, db, flags, users, repository };
};

const patch = (
  service: ProductUpdatesService,
  accountId: string,
  body: Record<string, unknown>,
) =>
  service.updateProgress(accountId, RELEASE.releaseId, RELEASE.tourVersion, {
    eventId: uuid(1),
    expectedRevision: 0,
    action: 'start',
    ...body,
  } as any);

describe('ProductUpdatesService manifest', () => {
  it('offers the permanent entry but no release when nothing is approved', async () => {
    for (const [raw, reason] of [
      [undefined, 'no_release_configured'],
      ['{broken', 'release_config_invalid'],
      [{ ...RELEASE, enabled: false }, 'release_disabled'],
      [{ ...RELEASE, environment: 'staging' }, 'environment_mismatch'],
      [
        { ...RELEASE, releasedAt: '2099-01-01T00:00:00.000Z' },
        'release_not_yet_published',
      ],
    ] as const) {
      const { service } = setup({ raw });
      const response = await service.getProductUpdates('acct-1');
      expect(response.release).toBeNull();
      expect(response.unavailableReason).toBe(reason);
      expect(response.invitation).toEqual({
        shouldInvite: false,
        reason: 'no_release',
      });
      expect(response.entry).toEqual({
        available: true,
        labelKey: 'productUpdates.entry',
      });
      expect(response.progress).toBeNull();
    }
  });

  it('turns an available feature into an actionable step with a closed route key', async () => {
    const { service } = setup({ raw: RELEASE });
    const response = await service.getProductUpdates('acct-1');
    expect(response.release.steps).toEqual([
      {
        stepId: 'packing_intro',
        featureId: 'packing_workflow',
        featureVersion: '1',
        order: 1,
        anchorId: 'nav-packing',
        titleKey: 'productUpdates.growth-2026-09.steps.packing_intro.title',
        bodyKey: 'productUpdates.growth-2026-09.steps.packing_intro.body',
        action: { kind: 'navigate', routeKey: 'workflows' },
      },
      {
        stepId: 'templates_intro',
        featureId: 'data_templates',
        featureVersion: '1',
        order: 2,
        anchorId: 'nav-templates',
        titleKey: 'productUpdates.growth-2026-09.steps.templates_intro.title',
        bodyKey: 'productUpdates.growth-2026-09.steps.templates_intro.body',
        action: { kind: 'navigate', routeKey: 'templates' },
      },
    ]);
    expect(response.release.upgrades).toEqual([]);
    expect(response.invitation).toEqual({
      shouldInvite: true,
      reason: 'registered_before_release',
    });
  });

  it('shows a pilot step even when the feature is not globally released', async () => {
    const { service } = setup({
      raw: RELEASE,
      featureStates: features({
        packing_workflow: {
          available: true,
          eligible: true,
          entitled: true,
          released: false,
        },
      }),
    });
    const response = await service.getProductUpdates('acct-1');
    expect(response.release.steps.map((step) => step.stepId)).toEqual([
      'packing_intro',
    ]);
    expect(response.release.upgrades).toEqual([]);
  });

  it('downgrades an actionable step into upgrade information without navigation', async () => {
    const { service } = setup({
      raw: RELEASE,
      plan: 'free',
      featureStates: features({
        packing_workflow: {
          available: false,
          entitled: false,
          released: true,
          minimumPlan: 'pro',
        },
        data_templates: {
          available: true,
          eligible: true,
          entitled: true,
          released: true,
        },
      }),
    });
    const response = await service.getProductUpdates('acct-1');
    expect(response.release.steps.map((step) => step.stepId)).toEqual([
      'templates_intro',
    ]);
    expect(response.release.upgrades).toEqual([
      {
        featureId: 'packing_workflow',
        featureVersion: '1',
        minimumPlan: 'pro',
        titleKey: 'productUpdates.upgrade.packing_workflow.title',
        bodyKey: 'productUpdates.upgrade.packing_workflow.body',
        action: { kind: 'upgrade_info' },
      },
    ]);
    expect(JSON.stringify(response.release.upgrades)).not.toContain('routeKey');
  });

  it('omits a feature stopped by the kill switch or left in control', async () => {
    const { service } = setup({
      raw: RELEASE,
      featureStates: features({
        // Kill switch: con entitlement pero sin disponibilidad ni oferta.
        packing_workflow: { available: false, entitled: true, released: false },
        // Variante control de un piloto ya liberado.
        data_templates: { available: false, entitled: true, released: true },
      }),
    });
    const response = await service.getProductUpdates('acct-1');
    expect(response.release).toBeNull();
    expect(response.unavailableReason).toBe('no_available_features');
    expect(response.invitation.reason).toBe('no_available_features');
  });

  it('does not invite accounts registered after the release, nor unknown registrations', async () => {
    const after = setup({
      raw: RELEASE,
      createdAt: new Date('2026-09-10T00:00:00.000Z'),
    });
    const afterResponse = await after.service.getProductUpdates('acct-1');
    expect(afterResponse.release.steps).toHaveLength(2);
    expect(afterResponse.invitation).toEqual({
      shouldInvite: false,
      reason: 'registered_after_release',
    });
    for (const createdAt of [null, 'not-a-date', 12345]) {
      const { service } = setup({ raw: RELEASE, createdAt });
      const response = await service.getProductUpdates('acct-1');
      expect(response.invitation).toEqual({
        shouldInvite: false,
        reason: 'registration_unknown',
      });
    }
    // Un Timestamp de Firestore sin convertir sigue siendo una fecha válida.
    const legacy = setup({
      raw: RELEASE,
      createdAt: { toDate: () => new Date('2026-07-01T00:00:00.000Z') },
    });
    expect(
      (await legacy.service.getProductUpdates('acct-1')).invitation
        .shouldInvite,
    ).toBe(true);
  });

  it('invites a plan with zero steps to the summary of published updates', async () => {
    // Free y Lite no incluyen ninguna función del release, pero sí pueden
    // enterarse de lo ya publicado; el resumen no promete acceso.
    const { service } = setup({
      raw: RELEASE,
      plan: 'free',
      featureStates: features({
        packing_workflow: { released: true, minimumPlan: 'pro' },
        data_templates: { released: true, minimumPlan: 'pro' },
      }),
    });
    const response = await service.getProductUpdates('acct-1');
    expect(response.release.steps).toEqual([]);
    expect(response.release.upgrades).toHaveLength(2);
    expect(response.invitation).toEqual({
      shouldInvite: true,
      reason: 'registered_before_release',
    });
    expect(JSON.stringify(response.release.upgrades)).not.toContain('routeKey');
  });

  it('keeps the invitation suppressed after a replay, not only while terminal', async () => {
    const { service } = setup({ raw: RELEASE });
    await patch(service, 'acct-1', { action: 'skip', eventId: uuid(1) });
    await patch(service, 'acct-1', {
      action: 'replay',
      eventId: uuid(2),
      expectedRevision: 1,
    });
    const response = await service.getProductUpdates('acct-1');
    expect(response.progress.state).toBe('started');
    expect(response.progress.invitationSuppressed).toBe(true);
    expect(response.invitation).toEqual({
      shouldInvite: false,
      reason: 'invitation_suppressed',
    });
  });

  it('suppresses the invitation once the tour is skipped or completed', async () => {
    const { service } = setup({ raw: RELEASE });
    await patch(service, 'acct-1', { action: 'skip', eventId: uuid(1) });
    let response = await service.getProductUpdates('acct-1');
    expect(response.progress.state).toBe('skipped');
    expect(response.invitation).toEqual({
      shouldInvite: false,
      reason: 'already_skipped',
    });
    await patch(service, 'acct-1', {
      action: 'complete',
      eventId: uuid(2),
      expectedRevision: 1,
    });
    response = await service.getProductUpdates('acct-1');
    expect(response.invitation).toEqual({
      shouldInvite: false,
      reason: 'already_completed',
    });
  });

  it('invites to resume after closing, keeping the position', async () => {
    const { service } = setup({ raw: RELEASE });
    await patch(service, 'acct-1', {
      action: 'view_step',
      stepId: 'templates_intro',
      eventId: uuid(1),
    });
    await patch(service, 'acct-1', {
      action: 'close',
      eventId: uuid(2),
      expectedRevision: 1,
    });
    const response = await service.getProductUpdates('acct-1');
    expect(response.progress.state).toBe('closed');
    expect(response.progress.lastStepId).toBe('templates_intro');
    expect(response.invitation).toEqual({
      shouldInvite: true,
      reason: 'resume_available',
    });
  });

  it('does not invite when stored progress cannot be trusted', async () => {
    const { service, db } = setup({ raw: RELEASE });
    db.docs.set(
      `${PRODUCT_TOUR_PROGRESS_COLLECTION}/${progressDocId(
        'acct-1',
        RELEASE.releaseId,
        RELEASE.tourVersion,
      )}`,
      {
        accountId: 'acct-1',
        releaseId: RELEASE.releaseId,
        tourVersion: '1',
        state: 'weird',
      },
    );
    const response = await service.getProductUpdates('acct-1');
    expect(response.progress).toBeNull();
    expect(response.invitation).toEqual({
      shouldInvite: false,
      reason: 'progress_unavailable',
    });
  });

  it('isolates progress per account', async () => {
    const { service, db } = setup({ raw: RELEASE });
    await patch(service, 'acct-1', {
      action: 'view_step',
      stepId: 'packing_intro',
      eventId: uuid(1),
    });
    const mine = await service.getProductUpdates('acct-1');
    const other = await service.getProductUpdates('acct-2');
    expect(mine.progress.visitedStepIds).toEqual(['packing_intro']);
    expect(other.progress.visitedStepIds).toEqual([]);
    expect(other.progress.revision).toBe(0);
    expect([...db.docs.keys()]).toEqual([
      `${PRODUCT_TOUR_PROGRESS_COLLECTION}/${progressDocId(
        'acct-1',
        RELEASE.releaseId,
        RELEASE.tourVersion,
      )}`,
    ]);
    // Id derivado del triplete por hash: sin separadores que un uid pueda traer.
    const id = progressDocId('acct-1', RELEASE.releaseId, RELEASE.tourVersion);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain('acct-1');
    expect(progressDocId('acct-1__growth-2026-09', '1', '')).not.toBe(id);
  });
});

describe('ProductUpdatesService progress', () => {
  it('rejects progress for a release that is not approved', async () => {
    const { service } = setup({ raw: RELEASE });
    await expect(
      service.updateProgress('acct-1', 'other-release', '1', {
        eventId: uuid(1),
        expectedRevision: 0,
        action: 'start',
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateProgress('acct-1', RELEASE.releaseId, '2', {
        eventId: uuid(1),
        expectedRevision: 0,
        action: 'start',
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    const disabled = setup({ raw: { ...RELEASE, enabled: false } });
    await expect(patch(disabled.service, 'acct-1', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('enforces the configured step allowlist regardless of flags', async () => {
    const { service } = setup({
      raw: RELEASE,
      // El paso de plantillas sigue en la allowlist aunque su flag esté apagada.
      featureStates: features({
        packing_workflow: { available: true, eligible: true, entitled: true },
      }),
    });
    await expect(
      patch(service, 'acct-1', { action: 'view_step' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      patch(service, 'acct-1', { action: 'view_step', stepId: 'invented' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const result = await patch(service, 'acct-1', {
      action: 'view_step',
      stepId: 'templates_intro',
    });
    expect(result.applied).toBe(true);
    expect(result.progress.visitedStepIds).toEqual(['templates_intro']);
  });

  it('confirms a retried event instead of failing the revision check', async () => {
    const { service } = setup({ raw: RELEASE });
    const first = await patch(service, 'acct-1', { action: 'start' });
    expect(first).toMatchObject({ applied: true, duplicate: false });
    const retry = await patch(service, 'acct-1', { action: 'start' });
    expect(retry).toMatchObject({ applied: false, duplicate: true });
    expect(retry.progress.revision).toBe(1);
  });

  it('reports a revision conflict with the stored progress', async () => {
    const { service } = setup({ raw: RELEASE });
    await patch(service, 'acct-1', { action: 'start', eventId: uuid(1) });
    const conflict = patch(service, 'acct-1', {
      action: 'complete',
      eventId: uuid(2),
      expectedRevision: 0,
    });
    await expect(conflict).rejects.toBeInstanceOf(ConflictException);
    await conflict.catch((error: ConflictException) => {
      const response = error.getResponse() as Record<string, any>;
      expect(response.error).toBe('revision_conflict');
      expect(response.data.currentRevision).toBe(1);
      expect(response.data.progress.state).toBe('started');
    });
  });

  it('refuses a reused event id that carries a different body', async () => {
    const { service } = setup({ raw: RELEASE });
    await patch(service, 'acct-1', {
      action: 'view_step',
      stepId: 'packing_intro',
      eventId: uuid(1),
    });
    const reused = patch(service, 'acct-1', {
      action: 'skip',
      eventId: uuid(1),
    });
    await expect(reused).rejects.toBeInstanceOf(ConflictException);
    await reused.catch((error: ConflictException) => {
      const response = error.getResponse() as Record<string, any>;
      expect(response.error).toBe('event_id_reused');
      expect(response.data.currentRevision).toBe(1);
      expect(response.data.progress.state).toBe('started');
    });
  });

  it('refuses to write progress for an account marked for deletion', async () => {
    const { service, db } = setup({ raw: RELEASE });
    db.docs.set('deleted_accounts/acct-1', { deletedAt: 'now' });
    await expect(patch(service, 'acct-1', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(db.docs.has('deleted_accounts/acct-1')).toBe(true);
    expect([...db.docs.keys()]).toEqual(['deleted_accounts/acct-1']);
  });

  it('stores only bookkeeping fields, with the account id at top level', async () => {
    const { service, db } = setup({ raw: RELEASE });
    await patch(service, 'acct-1', {
      action: 'view_step',
      stepId: 'packing_intro',
    });
    const stored = db.docs.get(
      `${PRODUCT_TOUR_PROGRESS_COLLECTION}/${progressDocId(
        'acct-1',
        RELEASE.releaseId,
        RELEASE.tourVersion,
      )}`,
    );
    expect(stored.accountId).toBe('acct-1');
    expect(Object.keys(stored).sort()).toEqual(
      [
        'accountId',
        'appliedEvents',
        'closedAt',
        'completedAt',
        'invitationSuppressed',
        'lastStepId',
        'releaseId',
        'replays',
        'revision',
        'schemaVersion',
        'skippedAt',
        'startedAt',
        'state',
        'terminalHistory',
        'tourVersion',
        'updatedAt',
        'visitedStepIds',
      ].sort(),
    );
    // Sin TTL: omitir o completar deben suprimir invitaciones sin caducidad.
    expect(stored.expiresAt).toBeUndefined();
  });
});
