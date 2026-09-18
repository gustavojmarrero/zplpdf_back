import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import type { FeatureId } from '../product-observability/observability.types.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';
import {
  CANONICAL_ROUTE_KEYS,
  PRODUCT_UPDATES_ENTRY_LABEL_KEY,
  releaseSummaryKey,
  releaseTitleKey,
  stepBodyKey,
  stepTitleKey,
  toProgressView,
  upgradeBodyKey,
  upgradeTitleKey,
} from './product-updates.types.js';
import type {
  InvitationReason,
  PublicProductCatalog,
  ProductTourStep,
  ProductUpdatesReleaseView,
  ProductUpdatesResponse,
  TourProgressRecord,
  TourProgressResult,
  UpgradeNotice,
} from './product-updates.types.js';
import { loadApprovedRelease, releaseStepIds } from './release-config.js';
import type { ProductUpdatesRelease } from './release-config.js';
import { TourProgressRepository } from './tour-progress.repository.js';
import type { TourProgressDto } from './product-updates.dto.js';

/** Lo que este módulo consume del catálogo de flags, propiedad de root. */
interface FeatureState {
  featureId: FeatureId;
  featureVersion: string;
  available: boolean;
  entitled: boolean;
  released: boolean;
  minimumPlan: PlanType;
}

@Injectable()
export class ProductUpdatesService {
  private readonly logger = new Logger(ProductUpdatesService.name);

  constructor(
    private readonly flags: FeatureFlagsService,
    private readonly users: FirestoreService,
    private readonly config: ConfigService,
    private readonly progress: TourProgressRepository,
  ) {}

  private environment(): string {
    return (
      this.config.get<string>('PRODUCT_ENVIRONMENT') ??
      this.config.get<string>('NODE_ENV') ??
      'development'
    );
  }

  private approvedRelease(now: Date) {
    return loadApprovedRelease({
      raw: this.config.get<string>('PRODUCT_UPDATES_RELEASE'),
      environment: this.environment(),
      now,
    });
  }

  getPublicCatalog(): PublicProductCatalog {
    const empty: PublicProductCatalog = {
      schemaVersion: 1,
      releaseId: null,
      manifestVersion: null,
      features: [],
    };
    const approved = this.approvedRelease(new Date());
    if (!approved.ok) return empty;
    try {
      const features = this.flags
        .getGloballyReleasedFeatures()
        .filter((feature) =>
          approved.release.releasedFeatureIds.includes(feature.featureId),
        );
      if (!features.length) return empty;
      return {
        schemaVersion: 1,
        releaseId: approved.release.releaseId,
        manifestVersion: approved.release.manifestVersion,
        features,
      };
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      // A malformed flag configuration must never advertise access publicly.
      return empty;
    }
  }

  /** `createdAt` vuelve como Date convertido o como ISO en cuentas antiguas. */
  private registeredAt(value: unknown): Date | null {
    if (value instanceof Date)
      return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? new Date(parsed) : null;
    }
    if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
      try {
        const date = (value as { toDate: () => Date }).toDate();
        return date instanceof Date && Number.isFinite(date.getTime())
          ? date
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Config aprobada (despliegue probado en el entorno) combinada con flags:
   * disponible = paso accionable; liberado pero sin entitlement = solo
   * información de upgrade; cualquier otro caso = omitido.
   */
  private buildRelease(
    release: ProductUpdatesRelease,
    features: FeatureState[],
  ): ProductUpdatesReleaseView {
    const byId = new Map(features.map((f) => [f.featureId, f]));
    const steps: ProductTourStep[] = [];
    for (const step of release.steps) {
      const feature = byId.get(step.featureId);
      if (!feature?.available) continue;
      steps.push({
        stepId: step.stepId,
        featureId: step.featureId,
        featureVersion: feature.featureVersion,
        order: step.order,
        anchorId: step.anchorId,
        titleKey: stepTitleKey(release.releaseId, step.stepId),
        bodyKey: stepBodyKey(release.releaseId, step.stepId),
        // Solo navegación explícita, con clave de destino de lista cerrada.
        action: {
          kind: 'navigate',
          routeKey: CANONICAL_ROUTE_KEYS[step.featureId],
        },
      });
    }
    const upgrades: UpgradeNotice[] = [];
    for (const featureId of release.releasedFeatureIds) {
      const feature = byId.get(featureId);
      if (!feature || feature.entitled || !feature.released) continue;
      upgrades.push({
        featureId,
        featureVersion: feature.featureVersion,
        minimumPlan: feature.minimumPlan,
        titleKey: upgradeTitleKey(featureId),
        bodyKey: upgradeBodyKey(featureId),
        action: { kind: 'upgrade_info' },
      });
    }
    return {
      releaseId: release.releaseId,
      tourVersion: release.tourVersion,
      manifestVersion: release.manifestVersion,
      environment: release.environment,
      releasedAt: release.releasedAt,
      titleKey: releaseTitleKey(release.releaseId),
      summaryKey: releaseSummaryKey(release.releaseId),
      steps,
      upgrades,
    };
  }

  async getProductUpdates(accountId: string): Promise<ProductUpdatesResponse> {
    const now = new Date();
    const { plan, features } = await this.flags.getFeatures(accountId);
    const entry: ProductUpdatesResponse['entry'] = {
      available: true,
      labelKey: PRODUCT_UPDATES_ENTRY_LABEL_KEY,
    };
    const unavailable = (
      reason: string,
      invitation: InvitationReason,
    ): ProductUpdatesResponse => ({
      schemaVersion: 1,
      plan,
      entry,
      release: null,
      invitation: { shouldInvite: false, reason: invitation },
      progress: null,
      unavailableReason: reason,
    });

    const approved = this.approvedRelease(now);
    if (!approved.ok) return unavailable(approved.reason, 'no_release');

    const view = this.buildRelease(
      approved.release,
      features as FeatureState[],
    );
    if (!view.steps.length && !view.upgrades.length)
      return unavailable('no_available_features', 'no_available_features');

    const { releaseId, tourVersion } = approved.release;
    let record: TourProgressRecord | null = null;
    let progressUnavailable = false;
    try {
      record = await this.progress.get(accountId, releaseId, tourVersion);
    } catch (error) {
      // Sin progreso confiable no se invita automáticamente.
      if (error instanceof UnauthorizedException) throw error;
      progressUnavailable = true;
      this.logger.warn(
        `Tour progress unreadable for release ${releaseId}/${tourVersion}`,
      );
    }

    const registeredAt = progressUnavailable
      ? null
      : this.registeredAt((await this.users.getUserById(accountId))?.createdAt);
    const invitation = this.decideInvitation({
      progressUnavailable,
      state: record?.state,
      suppressed: Boolean(record?.invitationSuppressed),
      presentableItems: view.steps.length + view.upgrades.length,
      registeredAt,
      releasedAt: approved.release.releasedAt,
    });

    return {
      schemaVersion: 1,
      plan,
      entry,
      release: view,
      invitation,
      progress: record ? toProgressView(record) : null,
    };
  }

  private decideInvitation(input: {
    progressUnavailable: boolean;
    state?: string;
    suppressed: boolean;
    presentableItems: number;
    registeredAt: Date | null;
    releasedAt: string;
  }): { shouldInvite: boolean; reason: InvitationReason } {
    const no = (reason: InvitationReason) => ({ shouldInvite: false, reason });
    if (input.progressUnavailable) return no('progress_unavailable');
    if (input.state === 'skipped') return no('already_skipped');
    if (input.state === 'completed') return no('already_completed');
    // La supresión sobrevive a repetir: el estado volvió a `started`, pero la
    // invitación automática no vuelve.
    if (input.suppressed) return no('invitation_suppressed');
    // Free y Lite pueden tener cero pasos y aun así recibir el resumen de
    // novedades ya publicadas que su plan no incluye.
    if (!input.presentableItems) return no('no_available_features');
    if (!input.registeredAt) return no('registration_unknown');
    if (input.registeredAt.getTime() >= Date.parse(input.releasedAt))
      return no('registered_after_release');
    return {
      shouldInvite: true,
      reason:
        input.state === 'pending'
          ? 'registered_before_release'
          : 'resume_available',
    };
  }

  async updateProgress(
    accountId: string,
    releaseId: string,
    tourVersion: string,
    body: TourProgressDto,
  ): Promise<TourProgressResult> {
    const now = new Date();
    // Valida cuenta y lápida sin provocar asignaciones de experimento.
    await this.flags.account(accountId);
    const approved = this.approvedRelease(now);
    if (
      !approved.ok ||
      approved.release.releaseId !== releaseId ||
      approved.release.tourVersion !== tourVersion
    )
      throw new NotFoundException({
        error: 'release_not_available',
        message: 'Unknown or unpublished product updates release',
      });

    const allowlist = releaseStepIds(approved.release);
    if (body.action === 'view_step' && !body.stepId)
      throw new BadRequestException({
        error: 'tour_step_required',
        message: 'stepId is required for view_step',
      });
    if (body.stepId && !allowlist.includes(body.stepId))
      throw new BadRequestException({
        error: 'tour_step_unknown',
        message: 'stepId is not part of the approved release',
      });

    const outcome = await this.progress.apply(
      accountId,
      releaseId,
      tourVersion,
      {
        eventId: body.eventId,
        expectedRevision: body.expectedRevision,
        action: body.action,
        stepId: body.stepId,
      },
      now,
    );
    if (outcome.kind === 'conflict' || outcome.kind === 'event_conflict')
      throw new ConflictException(
        outcome.kind === 'conflict'
          ? {
              error: 'revision_conflict',
              message: 'Stored tour progress has a different revision',
              data: {
                currentRevision: outcome.record.revision,
                progress: toProgressView(outcome.record),
              },
            }
          : {
              // Reutilizar un eventId con otro cuerpo no es un reintento y no
              // puede confirmarse en silencio.
              error: 'event_id_reused',
              message: 'eventId was already applied with a different body',
              data: {
                currentRevision: outcome.record.revision,
                progress: toProgressView(outcome.record),
              },
            },
      );
    return {
      schemaVersion: 1,
      applied: outcome.kind === 'applied' && outcome.changed,
      duplicate: outcome.kind === 'duplicate',
      progress: toProgressView(outcome.record),
    };
  }
}
