/**
 * Interfaces para analytics de llamadas a Labelary API
 * Métricas agregadas por hora en GMT-6 (Mérida, México)
 */

export interface HourlyLabelaryStats {
  hourKey: string; // "2025-12-23T14" (YYYY-MM-DDTHH en GMT-6)
  totalCalls: number;
  successCount: number;
  errorCount: number;
  rateLimitHits: number;
  totalResponseTimeMs: number;
  minResponseTimeMs: number;
  maxResponseTimeMs: number;
  labelCount: number; // Total labels procesados (incluyendo duplicados por ^PQ)
  uniqueLabelCount: number; // Labels únicos (después de deduplicación)
  updatedAt?: Date;
}

export interface LabelaryStatsSummary {
  totalCalls: number;
  avgResponseTimeMs: number;
  errorRate: number; // porcentaje (0-100)
  rateLimitRate: number; // porcentaje (0-100)
  peakHour: string;
  peakCallCount: number;
  totalLabelsProcessed: number;
}

export interface LabelaryStatsResponse {
  hourlyData: (HourlyLabelaryStats & { avgResponseTimeMs: number })[];
  summary: LabelaryStatsSummary;
  period: {
    hours: number;
    startHour: string;
    endHour: string;
  };
}

export interface LabelaryCallMetrics {
  responseTimeMs: number;
  labelCount: number;
  success: boolean;
  isRateLimit: boolean;
  errorMessage?: string;
}

// ==================== Issue #10: Labelary Metrics ====================

export interface LabelaryMetricsSummary {
  requestsToday: number;
  dailyLimit: number;
  peakHour: string;
  peakHourRequests: number;
  queuedUsers: number;
  errors429Today: number;
  avgResponseTime: number;
}

export interface HourlyDistribution {
  hour: string; // "00:00", "01:00", etc.
  requests: number;
  errors: number;
}

export interface DailyHistory {
  date: string; // "2025-12-17"
  requests: number;
  errors: number;
  uniqueLabels: number;
}

export interface EfficiencyMetrics {
  totalLabelsProcessed: number;
  uniqueLabelsConverted: number;
  deduplicationRatio: number; // porcentaje
  apiCallsSaved: number;
}

export interface SaturationMetrics {
  current: number; // porcentaje 0-100
  level: 'normal' | 'warning' | 'critical';
  estimatedExhaustion: string | null; // hora estimada de agotamiento o null
}

export interface LabelaryMetricsResponse {
  success: boolean;
  data: {
    summary: LabelaryMetricsSummary;
    hourlyDistribution: HourlyDistribution[];
    weeklyHistory: DailyHistory[];
    efficiency: EfficiencyMetrics;
    saturation: SaturationMetrics;
  };
}
