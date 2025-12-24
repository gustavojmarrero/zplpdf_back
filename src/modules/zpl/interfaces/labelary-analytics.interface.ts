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
  labelCount: number;
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
