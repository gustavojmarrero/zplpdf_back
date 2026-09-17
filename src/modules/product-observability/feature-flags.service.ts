import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { FirestoreService } from '../cache/firestore.service.js';
import { FEATURE_IDS, PLANS } from './observability.types.js';
import type { FeatureId } from './observability.types.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';

interface FlagConfig {
  enabled: boolean;
  killSwitch: boolean;
  owner: string;
  updatedAt: string;
  version: string;
  allowedPlans: PlanType[];
  rolloutPercent: number;
  experimentId: string;
  assignmentVersion: string;
}
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
@Injectable()
export class FeatureFlagsService {
  constructor(
    private readonly users: FirestoreService,
    private readonly config: ConfigService,
  ) {}

  async account(accountId: string) {
    if (!accountId || typeof accountId !== 'string')
      throw new UnauthorizedException();
    if (await this.users.isAccountDeletionMarked(accountId))
      throw new UnauthorizedException();
    const user = await this.users.getUserById(accountId);
    if (!user || !PLANS.includes(user.plan)) throw new UnauthorizedException();
    const simulated =
      user.role === 'admin' &&
      user.simulatedPlan &&
      user.simulationExpiresAt &&
      new Date(user.simulationExpiresAt).getTime() > Date.now();
    const plan = simulated ? user.simulatedPlan : user.plan;
    if (!PLANS.includes(plan)) throw new UnauthorizedException();
    return { plan, isSynthetic: user.role === 'admin' || Boolean(simulated) };
  }

  private flags(): Partial<Record<FeatureId, FlagConfig>> {
    try {
      const raw = this.config.get<string>('PRODUCT_FEATURE_FLAGS');
      if (!raw) return {};
      const flags = JSON.parse(raw);
      if (!flags || Array.isArray(flags) || typeof flags !== 'object')
        throw new Error();
      for (const [id, value] of Object.entries(flags)) {
        const f = value as FlagConfig;
        if (
          !FEATURE_IDS.includes(id as FeatureId) ||
          !f ||
          typeof f.enabled !== 'boolean' ||
          typeof f.killSwitch !== 'boolean' ||
          !VERSION.test(f.version ?? '') ||
          !VERSION.test(f.assignmentVersion ?? '') ||
          !VERSION.test(f.experimentId ?? '') ||
          typeof f.owner !== 'string' ||
          !f.owner.trim() ||
          !Number.isFinite(Date.parse(f.updatedAt)) ||
          !Array.isArray(f.allowedPlans) ||
          !f.allowedPlans.every((p) => PLANS.includes(p)) ||
          !Number.isFinite(f.rolloutPercent) ||
          f.rolloutPercent < 0 ||
          f.rolloutPercent > 100
        )
          throw new Error();
      }
      return flags;
    } catch {
      throw new ServiceUnavailableException(
        'Invalid server feature configuration',
      );
    }
  }

  async getFeatures(accountId: string) {
    const account = await this.account(accountId);
    const flags = this.flags();
    const features = await Promise.all(
      FEATURE_IDS.map(async (featureId) => {
        const f = flags[featureId];
        const eligible = Boolean(f?.allowedPlans.includes(account.plan));
        let assignment: {
          experimentId: string;
          assignmentVersion: string;
          variant: 'control' | 'treatment';
        } = null;
        if (f && eligible && f.enabled && !f.killSwitch) {
          const key = createHash('sha256')
            .update(
              JSON.stringify([accountId, f.experimentId, f.assignmentVersion]),
            )
            .digest('hex');
          const bucket =
            createHash('sha256').update(key).digest().readUInt32BE(0) /
            0x100000000;
          const variant =
            bucket * 100 < f.rolloutPercent ? 'treatment' : 'control';
          const db = this.users.getClient();
          const storedVariant = await db.runTransaction(async (tx) => {
            const ref = db.collection('growth_assignments').doc(key);
            const prior = await tx.get(ref);
            if (
              (await tx.get(db.collection('deleted_accounts').doc(accountId)))
                .exists
            )
              throw new UnauthorizedException();
            if (prior.exists) {
              const priorVariant = prior.get('variant');
              if (!['control', 'treatment'].includes(priorVariant))
                throw new ServiceUnavailableException(
                  'Invalid stored assignment',
                );
              return priorVariant as 'control' | 'treatment';
            }
            tx.create(ref, {
              accountId,
              experimentId: f.experimentId,
              assignmentVersion: f.assignmentVersion,
              assignedAt: new Date().toISOString(),
              initiallyPaid: account.plan !== 'free',
              featureId,
              variant,
              plan: account.plan,
              isSynthetic: account.isSynthetic,
              environment:
                this.config.get<string>('PRODUCT_ENVIRONMENT') ??
                this.config.get<string>('NODE_ENV') ??
                'development',
            });
            return variant;
          });
          assignment = {
            experimentId: f.experimentId,
            assignmentVersion: f.assignmentVersion,
            variant: storedVariant,
          };
        }
        return {
          featureId,
          featureVersion: f?.version ?? '1',
          available: Boolean(
            f?.enabled &&
              !f.killSwitch &&
              eligible &&
              assignment?.variant === 'treatment',
          ),
          eligible,
          flagVersion: f?.version ?? '1',
          experimentAssignment: assignment,
        };
      }),
    );
    return { schemaVersion: 1, plan: account.plan, features };
  }

  async assertFeatureAvailable(accountId: string, featureId: FeatureId) {
    const result = await this.getFeatures(accountId);
    const feature = result.features.find((f) => f.featureId === featureId);
    if (!feature?.available)
      throw new ForbiddenException('Feature unavailable');
    return feature;
  }
}
