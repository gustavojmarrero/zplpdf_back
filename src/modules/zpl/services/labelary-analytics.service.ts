import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FirestoreService } from '../../cache/firestore.service.js';
import {
  HourlyLabelaryStats,
  LabelaryStatsSummary,
  LabelaryStatsResponse,
  LabelaryCallMetrics,
} from '../interfaces/labelary-analytics.interface.js';

const GMT_OFFSET_HOURS = 6; // GMT-6 (Mérida, México)

@Injectable()
export class LabelaryAnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(LabelaryAnalyticsService.name);

  // Buffer en memoria para reducir escrituras a Firestore
  private statsBuffer: Map<string, HourlyLabelaryStats> = new Map();
  private readonly flushIntervalMs = 60000; // Flush cada 60 segundos
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(private readonly firestoreService: FirestoreService) {
    // Iniciar flush periódico
    this.flushInterval = setInterval(() => {
      this.flushToFirestore();
    }, this.flushIntervalMs);

    this.logger.log('LabelaryAnalyticsService inicializado con flush cada 60s');
  }

  onModuleDestroy() {
    // Limpiar intervalo y hacer flush final
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flushToFirestore();
  }

  /**
   * Obtiene la clave de hora actual en GMT-6
   * Formato: "2025-12-23T14" (YYYY-MM-DDTHH)
   */
  private getHourKey(date: Date = new Date()): string {
    const utcHours = date.getUTCHours();

    let year = date.getUTCFullYear();
    let month = date.getUTCMonth();
    let day = date.getUTCDate();
    let hour = utcHours - GMT_OFFSET_HOURS;

    // Ajustar si la hora es negativa (día anterior)
    if (hour < 0) {
      hour += 24;
      const prevDay = new Date(Date.UTC(year, month, day - 1));
      year = prevDay.getUTCFullYear();
      month = prevDay.getUTCMonth();
      day = prevDay.getUTCDate();
    }

    const monthStr = String(month + 1).padStart(2, '0');
    const dayStr = String(day).padStart(2, '0');
    const hourStr = String(hour).padStart(2, '0');

    return `${year}-${monthStr}-${dayStr}T${hourStr}`;
  }

  /**
   * Registra una llamada exitosa a Labelary
   */
  async trackSuccess(responseTimeMs: number, labelCount: number = 1): Promise<void> {
    const hourKey = this.getHourKey();
    const stats = this.getOrCreateStats(hourKey);

    stats.totalCalls++;
    stats.successCount++;
    stats.totalResponseTimeMs += responseTimeMs;
    stats.labelCount += labelCount;
    stats.minResponseTimeMs = Math.min(stats.minResponseTimeMs, responseTimeMs);
    stats.maxResponseTimeMs = Math.max(stats.maxResponseTimeMs, responseTimeMs);

    this.logger.debug(`Tracked success: ${responseTimeMs}ms, ${labelCount} labels`);
  }

  /**
   * Registra un hit de rate limit (429)
   */
  async trackRateLimit(responseTimeMs: number): Promise<void> {
    const hourKey = this.getHourKey();
    const stats = this.getOrCreateStats(hourKey);

    stats.totalCalls++;
    stats.rateLimitHits++;
    stats.totalResponseTimeMs += responseTimeMs;

    this.logger.warn(`Rate limit hit tracked: ${responseTimeMs}ms`);
  }

  /**
   * Registra un error de Labelary
   */
  async trackError(responseTimeMs: number, _errorMessage?: string): Promise<void> {
    const hourKey = this.getHourKey();
    const stats = this.getOrCreateStats(hourKey);

    stats.totalCalls++;
    stats.errorCount++;
    stats.totalResponseTimeMs += responseTimeMs;

    this.logger.debug(`Tracked error: ${responseTimeMs}ms`);
  }

  /**
   * Registra métricas de una llamada (método unificado)
   */
  async trackCall(metrics: LabelaryCallMetrics): Promise<void> {
    if (metrics.isRateLimit) {
      await this.trackRateLimit(metrics.responseTimeMs);
    } else if (metrics.success) {
      await this.trackSuccess(metrics.responseTimeMs, metrics.labelCount);
    } else {
      await this.trackError(metrics.responseTimeMs, metrics.errorMessage);
    }
  }

  /**
   * Obtiene o crea estadísticas para una hora
   */
  private getOrCreateStats(hourKey: string): HourlyLabelaryStats {
    if (!this.statsBuffer.has(hourKey)) {
      this.statsBuffer.set(hourKey, {
        hourKey,
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        rateLimitHits: 0,
        totalResponseTimeMs: 0,
        minResponseTimeMs: Infinity,
        maxResponseTimeMs: 0,
        labelCount: 0,
      });
    }
    return this.statsBuffer.get(hourKey)!;
  }

  /**
   * Flush del buffer a Firestore
   */
  private async flushToFirestore(): Promise<void> {
    const entries = Array.from(this.statsBuffer.entries());

    if (entries.length === 0) {
      return;
    }

    this.logger.debug(`Flushing ${entries.length} hourly stats to Firestore`);

    for (const [hourKey, stats] of entries) {
      try {
        // Normalizar minResponseTimeMs si no hay datos
        if (stats.minResponseTimeMs === Infinity) {
          stats.minResponseTimeMs = 0;
        }

        await this.firestoreService.saveLabelaryHourlyStats(stats);
        this.statsBuffer.delete(hourKey);
      } catch (error) {
        this.logger.error(`Error flushing stats for ${hourKey}: ${error}`);
        // Mantener en buffer para reintentar
      }
    }
  }

  /**
   * Obtiene estadísticas por hora para un rango de tiempo
   */
  async getHourlyStats(hours: number = 24): Promise<LabelaryStatsResponse> {
    // Calcular rango de horas
    const endHour = this.getHourKey();
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hours);
    const startHour = this.getHourKey(startDate);

    // Obtener datos de Firestore
    const hourlyData = await this.firestoreService.getLabelaryHourlyStatsRange(
      startHour,
      endHour,
    );

    // Calcular resumen
    const summary = this.calculateSummary(hourlyData);

    return {
      hourlyData,
      summary,
      period: {
        hours,
        startHour,
        endHour,
      },
    };
  }

  /**
   * Calcula el resumen de estadísticas
   */
  private calculateSummary(
    hourlyData: (HourlyLabelaryStats & { avgResponseTimeMs: number })[],
  ): LabelaryStatsSummary {
    if (hourlyData.length === 0) {
      return {
        totalCalls: 0,
        avgResponseTimeMs: 0,
        errorRate: 0,
        rateLimitRate: 0,
        peakHour: '',
        peakCallCount: 0,
        totalLabelsProcessed: 0,
      };
    }

    let totalCalls = 0;
    let totalResponseTimeMs = 0;
    let totalErrors = 0;
    let totalRateLimits = 0;
    let totalLabels = 0;
    let peakHour = '';
    let peakCallCount = 0;

    for (const stats of hourlyData) {
      totalCalls += stats.totalCalls;
      totalResponseTimeMs += stats.totalResponseTimeMs;
      totalErrors += stats.errorCount;
      totalRateLimits += stats.rateLimitHits;
      totalLabels += stats.labelCount;

      if (stats.totalCalls > peakCallCount) {
        peakCallCount = stats.totalCalls;
        peakHour = stats.hourKey;
      }
    }

    return {
      totalCalls,
      avgResponseTimeMs: totalCalls > 0 ? Math.round(totalResponseTimeMs / totalCalls) : 0,
      errorRate: totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 10000) / 100 : 0,
      rateLimitRate:
        totalCalls > 0 ? Math.round((totalRateLimits / totalCalls) * 10000) / 100 : 0,
      peakHour,
      peakCallCount,
      totalLabelsProcessed: totalLabels,
    };
  }

  /**
   * Obtiene estadísticas actuales del buffer (sin flush)
   */
  getBufferStats(): { bufferedHours: number; oldestHour: string | null } {
    const keys = Array.from(this.statsBuffer.keys()).sort();
    return {
      bufferedHours: keys.length,
      oldestHour: keys.length > 0 ? keys[0] : null,
    };
  }
}
