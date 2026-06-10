export type FeedbackSentiment = 'bad' | 'neutral' | 'good';

/**
 * Documento de la colección `feedback` (encuesta mensual de satisfacción).
 */
export interface Feedback {
  id: string;
  userId: string;
  userEmail: string | null;
  plan: string;
  sentiment: FeedbackSentiment;
  message: string | null;
  locale: string | null;
  createdAt: Date;
}

/** Datos para crear un feedback (sin id ni createdAt; los pone el servicio). */
export interface CreateFeedbackData {
  userId: string;
  userEmail: string | null;
  plan: string;
  sentiment: FeedbackSentiment;
  message: string | null;
  locale: string | null;
}

export interface FeedbackFilters {
  page?: number;
  limit?: number;
  sentiment?: FeedbackSentiment;
  plan?: string;
  startDate?: Date;
  endDate?: Date;
  search?: string;
}

export interface FeedbackSummary {
  total: number;
  bad: number;
  neutral: number;
  good: number;
  /** Porcentaje de respuestas "good" sobre el total (0-100). */
  satisfactionRate: number;
}

export interface FeedbackListResult {
  items: Feedback[];
  summary: FeedbackSummary;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface FeedbackStatus {
  /** Si debe mostrarse la encuesta ahora (cadencia 30 días rolling). */
  shouldShow: boolean;
  /** ISO del último feedback del usuario, o null si nunca. */
  lastSubmittedAt: string | null;
  /** Días transcurridos desde el último feedback, o null si nunca. */
  daysSinceLast: number | null;
}
