import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transaction } from '@google-cloud/firestore';
import { plainToInstance } from 'class-transformer';
import { isISO8601, isUUID, validateSync } from 'class-validator';
import { FeatureFlagsService } from './feature-flags.service.js';
import {
  ProductEventRepository,
  eventKey,
} from './product-event.repository.js';
import { exposureDay } from './product-event.repository.js';
import { WebProductEventsDto } from './product-event.dto.js';
import {
  FEATURE_IDS,
  SERVER_EVENTS,
  TOUR_EVENTS,
} from './observability.types.js';
import {
  loadApprovedRelease,
  isKnownTourMetadata,
} from '../product-updates/release-config.js';
import type { ProductEvent, ServerEventInput } from './observability.types.js';

const SERVER_KEYS = new Set([
  'eventId',
  'schemaVersion',
  'eventName',
  'accountId',
  'featureId',
  'featureVersion',
  'operationId',
  'occurredAt',
  'source',
  'workflowId',
  'jobId',
  'durationMs',
  'labelCount',
  'isSynthetic',
]);
const EVENT_FEATURE: Record<(typeof SERVER_EVENTS)[number], string> = {
  packing_export_succeeded: 'packing_workflow',
  packing_reexport_succeeded: 'packing_workflow',
  packing_reconcile_completed: 'packing_workflow',
  template_run_succeeded: 'data_templates',
  template_saved: 'data_templates',
  api_job_succeeded: 'self_service_api',
  pdf_preparation_export_succeeded: 'pdf_preparation',
  folder_run_succeeded: 'folder_automation',
  print_job_acknowledged: 'direct_print',
  print_confirmed: 'direct_print',
  regression_run_completed: 'template_regression',
  baseline_approved: 'template_regression',
};
@Injectable()
export class ProductObservabilityService {
  constructor(
    private readonly repository: ProductEventRepository,
    private readonly flags: FeatureFlagsService,
    private readonly config: ConfigService,
  ) {}

  private environment(): ProductEvent['environment'] {
    const value =
      this.config.get<string>('PRODUCT_ENVIRONMENT') ??
      this.config.get<string>('NODE_ENV') ??
      'development';
    if (!['development', 'test', 'staging', 'production'].includes(value))
      throw new BadRequestException('Invalid server environment');
    return value as ProductEvent['environment'];
  }

  async recordWebEvents(accountId: string, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Invalid event batch');
    const dto = plainToInstance(WebProductEventsDto, input);
    if (
      validateSync(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
      }).length ||
      !dto.consent
    )
      throw new BadRequestException('Invalid event schema or consent');
    const sentAge = Date.now() - Date.parse(dto.sentAt);
    if (sentAge > 7 * 86400000 || sentAge < -300000)
      throw new BadRequestException('Invalid sentAt');
    const account = await this.flags.account(accountId);
    const featureResponse = await this.flags.getFeatures(accountId);
    const receivedAt = new Date().toISOString();
    const approvedRelease = loadApprovedRelease({
      raw: this.config.get<string>('PRODUCT_UPDATES_RELEASE'),
      environment: this.environment(),
      now: new Date(),
    });
    const writes = dto.events.map((item) => {
      const age = Date.now() - Date.parse(item.occurredAt);
      const feature = featureResponse.features.find(
        (f) => f.featureId === item.featureId,
      );
      const isTour = TOUR_EVENTS.includes(
        item.eventName as (typeof TOUR_EVENTS)[number],
      );
      const upgradeVisible = isTour && feature?.released && !feature.entitled;
      if (
        (!feature?.available && !upgradeVisible) ||
        feature.featureVersion !== item.featureVersion
      )
        throw new BadRequestException('Feature unavailable or stale version');
      if (isTour) {
        const release = approvedRelease.ok ? approvedRelease.release : null;
        if (
          !item.releaseId ||
          !item.tourVersion ||
          item.surface !== 'tour' ||
          item.action ||
          !isKnownTourMetadata(release, {
            releaseId: item.releaseId,
            tourVersion: item.tourVersion,
            stepId: item.tourStepId,
          }) ||
          !release?.releasedFeatureIds.includes(item.featureId) ||
          (item.tourStepId &&
            !release.steps.some(
              (s) =>
                s.stepId === item.tourStepId && s.featureId === item.featureId,
            )) ||
          (item.eventName === 'tour_step_viewed' &&
            (!item.tourStepId || !feature.available)) ||
          (item.eventName === 'tour_feature_opened' && !feature.available) ||
          (item.eventName === 'tour_upgrade_clicked' && !upgradeVisible)
        )
          throw new BadRequestException('Invalid tour event context');
      } else if (
        item.releaseId !== undefined ||
        item.tourVersion !== undefined ||
        item.tourStepId !== undefined
      ) {
        throw new BadRequestException('Tour metadata on a non-tour event');
      }
      if (
        age > 7 * 86400000 ||
        age < -300000 ||
        (item.eventName === 'feature_exposed' && item.action) ||
        (item.eventName === 'feature_interacted' && !item.action)
      )
        throw new BadRequestException('Invalid event context');
      const event: ProductEvent = {
        ...item,
        sentAt: dto.sentAt,
        consentEpoch: dto.consentEpoch,
        sessionEpoch: dto.sessionEpoch,
        accountId,
        receivedAt,
        planAtEvent: account.plan,
        source: 'web',
        environment: this.environment(),
        isSynthetic: account.isSynthetic,
        consent: { analytics: true, version: dto.consent.version },
        ...(feature.experimentAssignment
          ? {
              experimentId: feature.experimentAssignment.experimentId,
              assignmentVersion: feature.experimentAssignment.assignmentVersion,
              variant: feature.experimentAssignment.variant,
            }
          : {}),
      };
      const fingerprint = eventKey(
        JSON.stringify([
          item.eventId,
          item.schemaVersion,
          item.eventName,
          item.featureId,
          item.featureVersion,
          item.eventName === 'feature_exposed'
            ? exposureDay(item.occurredAt)
            : item.occurredAt,
          item.surface,
          feature.experimentAssignment?.assignmentVersion,
          feature.experimentAssignment?.variant,
          item.action ?? null,
          ...(isTour
            ? [item.releaseId, item.tourVersion, item.tourStepId ?? null]
            : []),
          dto.consent.version,
        ]),
      );
      return { event, fingerprint };
    });
    return { schemaVersion: 1, results: await this.repository.record(writes) };
  }

  /** Internal only. Call after all transaction reads, before business writes. */
  async recordServerEvent(input: ServerEventInput, transaction?: Transaction) {
    if (
      !input ||
      Object.keys(input).some((key) => !SERVER_KEYS.has(key)) ||
      input.schemaVersion !== 1 ||
      !SERVER_EVENTS.includes(input.eventName) ||
      typeof input.featureVersion !== 'string' ||
      !FEATURE_IDS.includes(input.featureId) ||
      EVENT_FEATURE[input.eventName] !== input.featureId ||
      !isUUID(input.eventId, '4') ||
      !isUUID(input.operationId, '4') ||
      typeof input.accountId !== 'string' ||
      !input.accountId ||
      input.accountId.length > 128 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(input.featureVersion) ||
      !isISO8601(input.occurredAt, { strict: true }) ||
      !input.occurredAt.endsWith('Z') ||
      !['api', 'folder', 'print'].includes(input.source)
    )
      throw new BadRequestException('Invalid server event');
    for (const id of [input.workflowId, input.jobId])
      if (id !== undefined && !isUUID(id, '4'))
        throw new BadRequestException('Invalid opaque identifier');
    for (const count of [input.durationMs, input.labelCount])
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
        throw new BadRequestException('Invalid event count');
    if (
      input.isSynthetic !== undefined &&
      typeof input.isSynthetic !== 'boolean'
    )
      throw new BadRequestException('Invalid synthetic marker');
    const account = await this.flags.account(input.accountId);
    const event: ProductEvent = {
      ...input,
      receivedAt: new Date().toISOString(),
      planAtEvent: account.plan,
      environment: this.environment(),
      isSynthetic: account.isSynthetic || input.isSynthetic === true,
    };
    const fingerprint = eventKey(
      JSON.stringify(
        Object.keys(input)
          .sort()
          .map((key) => [key, input[key]]),
      ),
    );
    const [result] = await this.repository.record(
      [{ event, fingerprint }],
      transaction,
    );
    return result;
  }

  async quality() {
    const { quality, panel } = await this.repository.readQuality();
    const stale =
      quality && Date.now() - Date.parse(quality.generatedAt) > 3600000;
    return {
      schemaVersion: 1,
      status: !quality ? 'missing_data' : stale ? 'stale' : quality.status,
      reason: !quality
        ? 'no_verified_snapshot'
        : stale
          ? 'stale_quality'
          : 'queue_health',
      generatedAt: new Date().toISOString(),
      sourceWatermark:
        !stale && panel?.canEvaluateGrowth ? panel.sourceWatermark : null,
      pending: quality?.pending ?? null,
      dead: quality?.dead ?? null,
      countsTruncated: quality?.countsTruncated ?? null,
      coverage: null,
      eventCount: null,
      eligibleAccounts: null,
      exposedAccounts: null,
      activatedAccounts: null,
      canEvaluateGrowth: Boolean(
        !stale &&
          quality?.status === 'observed' &&
          panel?.canEvaluateGrowth &&
          Date.now() - Date.parse(panel.generatedAt) < 36 * 3600000,
      ),
    };
  }
  snapshots() {
    return {
      schemaVersion: 1,
      status: 'insufficient_data',
      reason: 'no_verified_snapshot',
      timezone: 'America/Merida',
      sourceWatermark: null,
      window: null,
      numerator: null,
      denominator: null,
      snapshots: [],
    };
  }
}
