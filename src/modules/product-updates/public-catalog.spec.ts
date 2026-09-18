import request from 'supertest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import {
  FEATURE_IDS,
  PLANS,
} from '../product-observability/observability.types.js';
import { ProductUpdatesController } from './product-updates.controller.js';
import { ProductUpdatesService } from './product-updates.service.js';
import { TourProgressRepository } from './tour-progress.repository.js';

const releasedFeatureIds = [
  'packing_workflow',
  'data_templates',
  'pdf_preparation',
  'template_regression',
  'self_service_api',
];
const release = {
  releaseId: 'growth-2026-09',
  tourVersion: '1',
  manifestVersion: '1',
  enabled: true,
  environment: 'production',
  releasedAt: '2026-01-01T00:00:00.000Z',
  releasedFeatureIds,
  steps: [
    {
      stepId: 'packing',
      featureId: 'packing_workflow',
      anchorId: 'nav-packing',
      order: 1,
    },
  ],
};
const flag = {
  enabled: true,
  killSwitch: false,
  owner: 'test-owner',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: '1',
  allowedPlans: PLANS,
  rolloutPercent: 100,
  experimentId: 'test-experiment',
  assignmentVersion: '1',
};
const flags = () =>
  Object.fromEntries(FEATURE_IDS.map((id) => [id, { ...flag }]));
const empty = {
  schemaVersion: 1,
  releaseId: null,
  manifestVersion: null,
  features: [],
};
const expected = {
  schemaVersion: 1,
  releaseId: release.releaseId,
  manifestVersion: release.manifestVersion,
  features: [
    { featureId: 'packing_workflow', minimumPlan: 'pro' },
    { featureId: 'data_templates', minimumPlan: 'pro' },
    { featureId: 'self_service_api', minimumPlan: 'enterprise' },
    { featureId: 'pdf_preparation', minimumPlan: 'pro' },
    { featureId: 'template_regression', minimumPlan: 'promax' },
  ],
};

function setup(
  releaseRaw: string = JSON.stringify(release),
  flagsRaw: string = JSON.stringify(flags()),
) {
  const config = new ConfigService({
    PRODUCT_ENVIRONMENT: 'production',
    PRODUCT_UPDATES_RELEASE: releaseRaw,
    PRODUCT_FEATURE_FLAGS: flagsRaw,
  });
  const forbidden = jest.fn(() => {
    throw new Error('Public catalog must not access account data or storage');
  });
  const users = {
    getClient: forbidden,
    getUserById: forbidden,
    isAccountDeletionMarked: forbidden,
  } as unknown as FirestoreService;
  const progress = {
    get: forbidden,
    apply: forbidden,
  } as unknown as TourProgressRepository;
  const featureFlags = new FeatureFlagsService(users, config);
  const service = new ProductUpdatesService(
    featureFlags,
    users,
    config,
    progress,
  );
  return { service, config, forbidden };
}

describe('public product catalog', () => {
  it('serves anonymous HTTP with only approved features, correct minimum plans and no storage access', async () => {
    const { service, forbidden } = setup();
    const guard = jest.fn(() => false);
    const module = await Test.createTestingModule({
      controllers: [ProductUpdatesController],
      providers: [{ provide: ProductUpdatesService, useValue: service }],
    })
      .overrideGuard(FirebaseAuthGuard)
      .useValue({ canActivate: guard })
      .compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/api/product-updates/catalog')
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual(expected);
      await request(app.getHttpServer())
        .get('/api/product-updates/catalog')
        .set('Authorization', 'Bearer ignored')
        .expect(200, expected);
      expect(guard).not.toHaveBeenCalled();
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ['missing', ''],
    ['malformed', '{'],
    ['wrong schema', '[]'],
    ['disabled', JSON.stringify({ ...release, enabled: false })],
    ['default disabled', JSON.stringify({ ...release, enabled: undefined })],
    [
      'future',
      JSON.stringify({ ...release, releasedAt: '2999-01-01T00:00:00Z' }),
    ],
    [
      'wrong environment',
      JSON.stringify({ ...release, environment: 'staging' }),
    ],
    [
      'invalid date',
      JSON.stringify({ ...release, releasedAt: '2026-02-31T00:00:00Z' }),
    ],
    [
      'unknown feature',
      JSON.stringify({ ...release, releasedFeatureIds: ['invented'] }),
    ],
  ])('fails closed for %s release', (_name, raw) => {
    const { service, forbidden } = setup(raw);
    expect(service.getPublicCatalog()).toEqual(empty);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '{}',
    '{',
    '[]',
    'null',
    JSON.stringify({ packing_workflow: { enabled: true } }),
    JSON.stringify({ unknown: flag }),
  ])('fails closed for absent/invalid flags %s', (raw) => {
    expect(setup(undefined, raw).service.getPublicCatalog()).toEqual(empty);
  });

  it.each([
    ['off', { enabled: false }],
    ['kill switch', { killSwitch: true }],
    ['partial rollout', { rolloutPercent: 99 }],
    ['control rollout', { rolloutPercent: 0 }],
    ['allowlist', { pilotAccountIds: ['private-account'] }],
    ['empty allowlist', { pilotAccountIds: [] }],
    ['missing eligible Pro', { allowedPlans: ['promax', 'enterprise'] }],
    ['missing eligible Pro Max', { allowedPlans: ['pro', 'enterprise'] }],
    ['missing eligible Enterprise', { allowedPlans: ['pro', 'promax'] }],
  ])(
    'omits a feature with %s without hiding other globally released features',
    (_name, override) => {
      const updated = {
        ...flags(),
        packing_workflow: { ...flag, ...override },
      };
      expect(
        setup(undefined, JSON.stringify(updated)).service.getPublicCatalog(),
      ).toEqual({
        ...expected,
        features: expected.features.filter(
          (f) => f.featureId !== 'packing_workflow',
        ),
      });
    },
  );

  it('does not require lower, unentitled plans in allowedPlans', () => {
    const updated = {
      packing_workflow: {
        ...flag,
        allowedPlans: ['pro', 'promax', 'enterprise'],
      },
      template_regression: { ...flag, allowedPlans: ['promax', 'enterprise'] },
      self_service_api: { ...flag, allowedPlans: ['enterprise'] },
    };
    expect(
      setup(undefined, JSON.stringify(updated)).service.getPublicCatalog()
        .features,
    ).toEqual(expected.features.filter((f) => f.featureId in updated));
  });

  it('returns an empty catalog if every released feature is off, and immediately reflects rollback', () => {
    const { service, config, forbidden } = setup();
    expect(service.getPublicCatalog()).toEqual(expected);
    config.set(
      'PRODUCT_FEATURE_FLAGS',
      JSON.stringify(
        Object.fromEntries(
          FEATURE_IDS.map((id) => [id, { ...flag, enabled: false }]),
        ),
      ),
    );
    expect(service.getPublicCatalog()).toEqual(empty);
    config.set('PRODUCT_FEATURE_FLAGS', JSON.stringify(flags()));
    expect(service.getPublicCatalog()).toEqual(expected);
    config.set(
      'PRODUCT_UPDATES_RELEASE',
      JSON.stringify({ ...release, enabled: false }),
    );
    expect(service.getPublicCatalog()).toEqual(empty);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
