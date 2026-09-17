import { ConfigService } from '@nestjs/config';
import { FirestoreService } from '../cache/firestore.service.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';
import { FeatureFlagsService } from './feature-flags.service.js';
import { FEATURE_IDS, PLANS } from './observability.types.js';

function fixture(plan: PlanType = 'pro') {
  const flags = Object.fromEntries(
    FEATURE_IDS.map((id) => [
      id,
      {
        enabled: true,
        killSwitch: false,
        owner: 'product',
        updatedAt: '2026-09-18T00:00:00.000Z',
        version: '1',
        allowedPlans: [...PLANS],
        rolloutPercent: 100,
        experimentId: `${id}-launch`,
        assignmentVersion: '1',
        pilotAccountIds: undefined as string[] | undefined,
      },
    ]),
  );
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => `${collection}/${id}`,
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (path: string) => ({
          exists: rows.has(path),
          get: (field: string) => rows.get(path)?.[field],
        }),
        create: (path: string, data: Record<string, unknown>) =>
          rows.set(path, data),
      }),
  };
  const user = { plan, role: 'user' };
  const users = {
    getUserById: jest.fn(async () => user),
    isAccountDeletionMarked: jest.fn(async () => false),
    getClient: () => db,
  };
  const settings: Record<string, string> = {};
  const config = {
    get: (key: string) =>
      key === 'PRODUCT_FEATURE_FLAGS' ? JSON.stringify(flags) : settings[key],
  };
  return {
    flags,
    rows,
    user,
    users,
    service: new FeatureFlagsService(
      users as unknown as FirestoreService,
      config as ConfigService,
    ),
  };
}

describe('Approved commercial feature access', () => {
  const expected: Record<PlanType, string[]> = {
    free: [],
    lite: [],
    pro: ['packing_workflow', 'data_templates', 'pdf_preparation'],
    promax: [
      'packing_workflow',
      'data_templates',
      'pdf_preparation',
      'folder_automation',
      'direct_print',
      'template_regression',
    ],
    enterprise: [...FEATURE_IDS],
  };
  for (const plan of PLANS) {
    for (const featureId of FEATURE_IDS) {
      it(`${plan}: server authorization for ${featureId}`, async () => {
        const { service } = fixture(plan);
        const response = await service.getFeatures('account');
        const feature = response.features.find(
          (item) => item.featureId === featureId,
        );
        const allowed = expected[plan].includes(featureId);
        expect(feature).toMatchObject({
          entitled: allowed,
          eligible: allowed,
          available: allowed,
          released: true,
        });
        if (allowed)
          await expect(
            service.assertFeatureAvailable('account', featureId),
          ).resolves.toBeDefined();
        else
          await expect(
            service.assertFeatureAvailable('account', featureId),
          ).rejects.toMatchObject({ status: 403 });
      });
    }
  }

  it('keeps paid entitlement but neither access nor advertising while a flag is off', async () => {
    const f = fixture('pro');
    f.flags.packing_workflow.enabled = false;
    expect((await f.service.getFeatures('account')).features[0]).toMatchObject({
      entitled: true,
      available: false,
      released: false,
    });
  });

  it('a pilot cannot advertise an upgrade to a tier excluded by rollout', async () => {
    const f = fixture('free');
    f.flags.packing_workflow.allowedPlans = ['enterprise'];
    expect((await f.service.getFeatures('account')).features[0]).toMatchObject({
      minimumPlan: 'pro',
      entitled: false,
      available: false,
      released: false,
    });
    f.flags.packing_workflow.allowedPlans = ['pro', 'promax', 'enterprise'];
    f.flags.packing_workflow.rolloutPercent = 10;
    expect((await f.service.getFeatures('account')).features[0].released).toBe(
      false,
    );
  });

  it('a kill switch removes access and upgrade advertising', async () => {
    const f = fixture('enterprise');
    await f.service.assertFeatureAvailable('account', 'direct_print');
    f.flags.direct_print.killSwitch = true;
    await expect(
      f.service.assertFeatureAvailable('account', 'direct_print'),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await f.service.getFeatures('account')).features.find(
        (x) => x.featureId === 'direct_print',
      ).released,
    ).toBe(false);
  });

  it('downgrade revokes an already assigned feature; upgrade never changes the subscription itself', async () => {
    const f = fixture('enterprise');
    await f.service.assertFeatureAvailable('account', 'self_service_api');
    f.user.plan = 'promax';
    await expect(
      f.service.assertFeatureAvailable('account', 'self_service_api'),
    ).rejects.toMatchObject({ status: 403 });
    await f.service.assertFeatureAvailable('account', 'direct_print');
    f.user.plan = 'lite';
    await expect(
      f.service.assertFeatureAvailable('account', 'packing_workflow'),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.user.plan).toBe('lite');
  });

  it('restricts a pilot to named accounts without exposing identities or reserving control assignments for others', async () => {
    const f = fixture('pro');
    f.flags.packing_workflow.pilotAccountIds = ['pilot-account'];
    const outsider = (await f.service.getFeatures('outsider')).features[0];
    expect(outsider).toMatchObject({
      eligible: true,
      available: false,
      released: false,
      experimentAssignment: null,
    });
    expect(JSON.stringify(outsider)).not.toContain('pilot-account');
    await expect(
      f.service.assertFeatureAvailable('pilot-account', 'packing_workflow'),
    ).resolves.toBeDefined();
    f.user.plan = 'free';
    await expect(
      f.service.assertFeatureAvailable('pilot-account', 'packing_workflow'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed for a pilot larger than the approved initial cap', async () => {
    const f = fixture('pro');
    f.flags.packing_workflow.pilotAccountIds = Array.from(
      { length: 16 },
      (_, i) => `account-${i}`,
    );
    await expect(f.service.getFeatures('account-0')).rejects.toMatchObject({
      status: 503,
    });
  });
});
