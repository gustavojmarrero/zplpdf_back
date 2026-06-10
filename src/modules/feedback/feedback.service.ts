import { Injectable, Logger } from '@nestjs/common';
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

    if (!last) {
      return { shouldShow: true, lastSubmittedAt: null, daysSinceLast: null };
    }

    const lastDate = new Date(last.createdAt);
    const daysSinceLast = Math.floor((Date.now() - lastDate.getTime()) / DAY_MS);

    return {
      shouldShow: daysSinceLast >= ROLLING_DAYS,
      lastSubmittedAt: lastDate.toISOString(),
      daysSinceLast,
    };
  }

  /**
   * Registra la respuesta del usuario. El plan y el email se toman del perfil
   * (fuente de verdad), no del cliente.
   */
  async submit(
    userId: string,
    tokenEmail: string | undefined,
    dto: CreateFeedbackDto,
  ): Promise<{ success: boolean }> {
    const user = await this.firestoreService.getUserById(userId);

    await this.firestoreService.createFeedback({
      userId,
      userEmail: user?.email || tokenEmail || null,
      plan: user?.plan || 'free',
      sentiment: dto.sentiment,
      message: dto.message?.trim() || null,
      locale: dto.locale || null,
    });

    return { success: true };
  }

  /**
   * Listado paginado + resumen para el panel admin.
   */
  async getAdminList(query: QueryFeedbackDto): Promise<FeedbackListResult> {
    const filters: FeedbackFilters = {
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 20,
      sentiment: query.sentiment,
      plan: query.plan,
      search: query.search,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    };

    return this.firestoreService.getFeedbackList(filters);
  }
}
