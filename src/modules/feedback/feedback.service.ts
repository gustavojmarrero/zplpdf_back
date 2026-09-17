import { randomUUID } from 'node:crypto';
import { GoneException, Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';
import type { CreateFeedbackDto } from './dto/create-feedback.dto.js';
import type { QueryFeedbackDto } from './dto/query-feedback.dto.js';
import type {
  FeedbackStatus,
  FeedbackListResult,
  FeedbackFilters,
} from '../../common/interfaces/feedback.interface.js';

/** Cadencia de la encuesta: 30 días rolling desde el último envío. */
const ROLLING_DAYS = 30;
const DAY_MS = 1000 * 60 * 60 * 24;

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(private readonly firestoreService: FirestoreService) {}

  /**
   * Decide si mostrar la encuesta al usuario (cadencia 30 días rolling).
   */
  async getStatus(userId: string): Promise<FeedbackStatus> {
    const last = await this.firestoreService.getLastFeedbackByUser(userId);
    const cadence = await this.firestoreService
      .getClient()
      .collection('feedback_cadence')
      .doc(userId)
      .get();
    const invitedAt = cadence.get('lastInvitedAt');
    if (invitedAt && Date.now() - Date.parse(invitedAt) < ROLLING_DAYS * DAY_MS)
      return {
        shouldShow: false,
        lastSubmittedAt: last ? new Date(last.createdAt).toISOString() : null,
        daysSinceLast: last
          ? Math.floor(
              (Date.now() - new Date(last.createdAt).getTime()) / DAY_MS,
            )
          : null,
      };

    if (!last) {
      return { shouldShow: true, lastSubmittedAt: null, daysSinceLast: null };
    }

    const lastDate = new Date(last.createdAt);
    const daysSinceLast = Math.floor(
      (Date.now() - lastDate.getTime()) / DAY_MS,
    );

    return {
      shouldShow: daysSinceLast >= ROLLING_DAYS,
      lastSubmittedAt: lastDate.toISOString(),
      daysSinceLast,
    };
  }

  /** Claim immediately before rendering, shared by every survey surface. */
  async claimInvitation(userId: string) {
    const last = await this.firestoreService.getLastFeedbackByUser(userId);
    const lastSubmitted = last ? new Date(last.createdAt).getTime() : 0;
    const db = this.firestoreService.getClient();
    return db.runTransaction(async (tx) => {
      const ref = db.collection('feedback_cadence').doc(userId);
      const row = (await tx.get(ref)).data();
      const candidate = await tx.get(
        db.collection('in_app_feedback_candidates').doc(userId),
      );
      const deleted = await tx.get(
        db.collection('deleted_accounts').doc(userId),
      );
      if (deleted.exists) throw new GoneException('Account unavailable');
      const latest = Math.max(
        lastSubmitted,
        Date.parse(row?.lastSubmittedAt ?? '') || 0,
        Date.parse(row?.lastInvitedAt ?? '') || 0,
      );
      if (Date.now() - latest < ROLLING_DAYS * DAY_MS)
        return {
          shouldShow: false,
          invitationId: null,
          featureId: null,
          nextEligibleAt: new Date(
            latest + ROLLING_DAYS * DAY_MS,
          ).toISOString(),
        };
      const now = new Date().toISOString(),
        invitationId = randomUUID();
      const featureId = candidate.get('featureId') ?? null;
      tx.set(
        ref,
        { accountId: userId, lastInvitedAt: now, invitationId, featureId },
        { merge: true },
      );
      if (candidate.exists)
        tx.update(candidate.ref, { state: 'claimed', claimedAt: now });
      return {
        shouldShow: true,
        invitationId,
        featureId,
        nextEligibleAt: new Date(
          Date.now() + ROLLING_DAYS * DAY_MS,
        ).toISOString(),
      };
    });
  }

  /**
   * Registra la respuesta del usuario. El plan y el email se toman del perfil
   * (fuente de verdad), no del cliente.
   */
  async submit(
    userId: string,
    tokenEmail: string | undefined,
    dto: CreateFeedbackDto,
  ): Promise<{ success: boolean; skipped?: boolean }> {
    // Defense-in-depth: la cadencia se valida también en el servidor, no solo
    // en el cliente (status.shouldShow). Evita que un doble envío o un POST
    // directo creen registros duplicados que sesguen las métricas. Idempotente:
    // si ya hay feedback reciente, se ignora silenciosamente (success: true).
    const last = await this.firestoreService.getLastFeedbackByUser(userId);
    if (last) {
      const daysSinceLast = Math.floor(
        (Date.now() - new Date(last.createdAt).getTime()) / DAY_MS,
      );
      if (daysSinceLast < ROLLING_DAYS) {
        this.logger.warn(
          `Feedback ignorado para ${userId}: último hace ${daysSinceLast}d (< ${ROLLING_DAYS}d)`,
        );
        return { success: true, skipped: true };
      }
    }

    const user = await this.firestoreService.getUserById(userId);

    const db = this.firestoreService.getClient();
    const saved = await db.runTransaction(async (tx) => {
      const ref = db.collection('feedback_cadence').doc(userId);
      const cadence = (await tx.get(ref)).data();
      if ((await tx.get(db.collection('deleted_accounts').doc(userId))).exists)
        throw new GoneException('Account unavailable');
      if (
        cadence?.lastSubmittedAt &&
        Date.now() - Date.parse(cadence.lastSubmittedAt) < ROLLING_DAYS * DAY_MS
      )
        return false;
      const createdAt = new Date();
      tx.create(db.collection('feedback').doc(randomUUID()), {
        userId,
        userEmail: user?.email || tokenEmail || null,
        plan: user?.plan || 'free',
        sentiment: dto.sentiment,
        message: dto.message?.trim() || null,
        locale: dto.locale || null,
        featureId: cadence?.featureId ?? null,
        invitationId: cadence?.invitationId ?? null,
        createdAt,
      });
      tx.set(
        ref,
        { accountId: userId, lastSubmittedAt: createdAt.toISOString() },
        { merge: true },
      );
      return true;
    });
    if (!saved) return { success: true, skipped: true };

    return { success: true };
  }

  /**
   * Listado paginado + resumen para el panel admin.
   */
  async getAdminList(query: QueryFeedbackDto): Promise<FeedbackListResult> {
    const filters: FeedbackFilters = {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      sentiment: query.sentiment,
      plan: query.plan,
      search: query.search,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    };

    return this.firestoreService.getFeedbackList(filters);
  }
}
