import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { FirestoreService } from '../../cache/firestore.service.js';
import { ExchangeRateService } from './exchange-rate.service.js';
import type {
  MonthlyGoal,
  GoalTargets,
  GoalAlerts,
  GoalMetricConfig,
  GoalHistoryItem,
} from '../../../common/interfaces/finance.interface.js';
import { DEFAULT_GOAL_METRICS } from '../../../common/interfaces/finance.interface.js';

export interface SetGoalsDto {
  month: string; // YYYY-MM
  targets: GoalTargets;
  metrics?: GoalMetricConfig[];
}

export interface GoalProgress {
  month: string;
  targets: GoalTargets;
  current: GoalTargets;
  progress: Record<string, number>; // Porcentajes
  metrics: GoalMetricConfig[];
  daysRemaining: number;
  daysElapsed: number;
  expectedPace: GoalTargets;
  alerts: GoalAlerts;
  status: 'on_track' | 'at_risk' | 'behind';
}

@Injectable()
export class GoalsService {
  private readonly logger = new Logger(GoalsService.name);
  private readonly ALERT_THRESHOLD = 0.8; // Alerta si estás por debajo del 80% del ritmo esperado

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * Establece objetivos para un mes
   */
  async setGoals(data: SetGoalsDto, adminEmail: string): Promise<MonthlyGoal> {
    // Validar formato del mes
    if (!/^\d{4}-\d{2}$/.test(data.month)) {
      throw new BadRequestException('Month must be in YYYY-MM format');
    }

    // Validar que todos los targets sean no negativos
    for (const [key, value] of Object.entries(data.targets)) {
      if (typeof value !== 'number' || value < 0) {
        throw new BadRequestException(`Target "${key}" must be a non-negative number`);
      }
    }

    const goalId = `goal_${data.month.replace(/-/g, '')}`;
    const now = new Date();

    // Verificar si ya existe un objetivo para este mes
    const existing = await this.firestoreService.getGoal(data.month);

    // Usar métricas proporcionadas o defaults filtrados por los targets enviados
    // Convertir a objetos planos para Firestore (no acepta objetos con prototipos)
    const rawMetrics = data.metrics || this.getRelevantDefaultMetrics(Object.keys(data.targets));
    const metrics = rawMetrics.map((m) => ({ ...m }));

    // Inicializar actual con las métricas definidas
    const initialActual: GoalTargets = {};
    for (const key of Object.keys(data.targets)) {
      initialActual[key] = existing?.actual?.[key] || 0;
    }

    const goal: MonthlyGoal = {
      id: goalId,
      month: data.month,
      targets: data.targets,
      actual: initialActual,
      metrics,
      alerts: existing?.alerts || {},
      createdBy: adminEmail,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    await this.firestoreService.saveGoal(goal);
    this.logger.log(`Set goals for ${data.month}: ${JSON.stringify(data.targets)}`);

    return goal;
  }

  /**
   * Obtiene objetivos de un mes específico
   */
  async getGoals(month?: string): Promise<MonthlyGoal | null> {
    const targetMonth = month || this.getCurrentMonth();
    return this.firestoreService.getGoal(targetMonth);
  }

  /**
   * Obtiene progreso hacia los objetivos
   */
  async getProgress(month?: string): Promise<GoalProgress> {
    const targetMonth = month || this.getCurrentMonth();
    const goal = await this.firestoreService.getGoal(targetMonth);

    if (!goal) {
      throw new NotFoundException(`No goals set for ${targetMonth}`);
    }

    // Calcular días transcurridos y restantes
    const { daysElapsed, daysRemaining, totalDays } = this.getMonthProgress(targetMonth);

    // Obtener valores actuales del mes
    const current = await this.calculateActuals(targetMonth, Object.keys(goal.targets));

    // Usar métricas guardadas o defaults
    const metrics = goal.metrics || this.getRelevantDefaultMetrics(Object.keys(goal.targets));

    // Calcular ritmo esperado
    const paceMultiplier = daysElapsed / totalDays;
    const expectedPace: GoalTargets = {};
    for (const key of Object.keys(goal.targets)) {
      expectedPace[key] = goal.targets[key] * paceMultiplier;
    }

    // Calcular porcentajes de progreso
    const progress: Record<string, number> = {};
    for (const key of Object.keys(goal.targets)) {
      const target = goal.targets[key];
      const currentValue = current[key] || 0;
      progress[key] = target > 0 ? Math.round((currentValue / target) * 10000) / 100 : 0;
    }

    // Calcular alertas
    const alerts: GoalAlerts = {};
    for (const key of Object.keys(goal.targets)) {
      const currentValue = current[key] || 0;
      const expectedValue = expectedPace[key] || 0;
      alerts[`belowPace_${key}`] = currentValue < expectedValue * this.ALERT_THRESHOLD;
    }

    // Determinar estado general
    const alertCount = Object.values(alerts).filter(Boolean).length;
    const totalMetrics = Object.keys(goal.targets).length;
    let status: 'on_track' | 'at_risk' | 'behind';
    if (alertCount === 0) {
      status = 'on_track';
    } else if (alertCount <= Math.ceil(totalMetrics / 3)) {
      status = 'at_risk';
    } else {
      status = 'behind';
    }

    // Redondear expectedPace
    const roundedExpectedPace: GoalTargets = {};
    for (const key of Object.keys(expectedPace)) {
      const metric = metrics.find((m) => m.key === key);
      if (metric?.type === 'number') {
        roundedExpectedPace[key] = Math.round(expectedPace[key]);
      } else {
        roundedExpectedPace[key] = Math.round(expectedPace[key] * 100) / 100;
      }
    }

    return {
      month: targetMonth,
      targets: goal.targets,
      current,
      progress,
      metrics,
      daysRemaining,
      daysElapsed,
      expectedPace: roundedExpectedPace,
      alerts,
      status,
    };
  }

  /**
   * Obtiene historial de metas de los últimos N meses
   */
  async getHistory(monthsCount: number = 6): Promise<{ history: GoalHistoryItem[] }> {
    const history: GoalHistoryItem[] = [];
    const currentDate = new Date();

    for (let i = 0; i < monthsCount; i++) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      const goal = await this.firestoreService.getGoal(month);
      if (goal) {
        // Calcular achieved y status
        const achieved = goal.actual || {};
        const status = this.calculateGoalStatus(goal.targets, achieved, month);

        history.push({
          month,
          targets: goal.targets,
          achieved,
          metrics: goal.metrics,
          status,
        });
      }
    }

    return { history };
  }

  /**
   * Actualiza los valores actuales de los objetivos (llamado por cron)
   */
  async updateActuals(): Promise<void> {
    const currentMonth = this.getCurrentMonth();
    const goal = await this.firestoreService.getGoal(currentMonth);

    if (!goal) {
      this.logger.debug(`No goals set for ${currentMonth}, skipping update`);
      return;
    }

    const metricKeys = Object.keys(goal.targets);
    const actual = await this.calculateActuals(currentMonth, metricKeys);

    // Calcular alertas
    const { daysElapsed, totalDays } = this.getMonthProgress(currentMonth);
    const paceMultiplier = daysElapsed / totalDays;

    const alerts: GoalAlerts = {};
    for (const key of metricKeys) {
      const expectedValue = goal.targets[key] * paceMultiplier;
      const currentValue = actual[key] || 0;
      alerts[`belowPace_${key}`] = currentValue < expectedValue * this.ALERT_THRESHOLD;
    }

    await this.firestoreService.updateGoalActuals(currentMonth, actual, alerts);
    this.logger.log(`Updated goal actuals for ${currentMonth}: ${JSON.stringify(actual)}`);
  }

  /**
   * Verifica alertas y retorna resumen
   */
  async checkAlerts(): Promise<{
    month: string;
    alerts: GoalAlerts;
    hasAlerts: boolean;
    summary: string;
  }> {
    const currentMonth = this.getCurrentMonth();

    try {
      const progress = await this.getProgress(currentMonth);

      const alertMessages: string[] = [];
      for (const [key, value] of Object.entries(progress.alerts)) {
        if (value) {
          const metricKey = key.replace('belowPace_', '');
          const metric = progress.metrics.find((m) => m.key === metricKey);
          alertMessages.push(metric?.label || metricKey);
        }
      }

      const hasAlerts = alertMessages.length > 0;
      const summary = hasAlerts
        ? `Estás por debajo del ritmo en: ${alertMessages.join(', ')}`
        : 'Todos los objetivos van según lo planeado';

      return {
        month: currentMonth,
        alerts: progress.alerts,
        hasAlerts,
        summary,
      };
    } catch {
      return {
        month: currentMonth,
        alerts: {},
        hasAlerts: false,
        summary: 'No hay objetivos configurados para este mes',
      };
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  private async calculateActuals(month: string, metricKeys: string[]): Promise<GoalTargets> {
    const { startDate, endDate } = this.getMonthDates(month);
    const actual: GoalTargets = {};

    // Obtener métricas base en paralelo
    const [revenueData, newUsers, proConversions] = await Promise.all([
      this.firestoreService.getRevenueByPeriod(startDate, endDate),
      this.firestoreService.getNewUsersInPeriod(startDate, endDate),
      this.firestoreService.getProConversionsInPeriod(startDate, endDate),
    ]);

    // Convertir ingresos USD a MXN para revenue
    let revenueMxn = revenueData.totalMxn;
    if (revenueData.totalUsd > 0) {
      try {
        const conversion = await this.exchangeRateService.convertUsdToMxn(
          revenueData.totalUsd,
          this.firestoreService,
        );
        revenueMxn += conversion.amountMxn;
      } catch {
        revenueMxn += revenueData.totalUsd * 20;
      }
    }

    // Mapear métricas disponibles
    for (const key of metricKeys) {
      switch (key) {
        case 'revenue':
          actual[key] = revenueMxn;
          break;
        case 'newUsers':
          actual[key] = newUsers;
          break;
        case 'proConversions':
          actual[key] = proConversions;
          break;
        case 'conversionRate':
          // Tasa de conversión = (proConversions / newUsers) * 100
          actual[key] = newUsers > 0 ? Math.round((proConversions / newUsers) * 10000) / 100 : 0;
          break;
        case 'traffic':
        case 'adsSpend':
        case 'cac':
          // Estas métricas requieren datos externos o manuales
          // Por ahora devolvemos 0, se pueden agregar más fuentes de datos
          actual[key] = 0;
          break;
        default:
          actual[key] = 0;
      }
    }

    return actual;
  }

  private getRelevantDefaultMetrics(targetKeys: string[]): GoalMetricConfig[] {
    const relevantMetrics = DEFAULT_GOAL_METRICS.filter((m) => targetKeys.includes(m.key));

    // Si hay métricas que no están en los defaults, crear configuración básica
    for (const key of targetKeys) {
      if (!relevantMetrics.find((m) => m.key === key)) {
        relevantMetrics.push({
          key,
          label: key.charAt(0).toUpperCase() + key.slice(1),
          type: 'number',
          icon: 'chart',
          color: 'blue',
          order: relevantMetrics.length + 1,
        });
      }
    }

    return relevantMetrics.sort((a, b) => a.order - b.order);
  }

  private calculateGoalStatus(
    targets: GoalTargets,
    achieved: GoalTargets,
    month: string,
  ): 'on_track' | 'at_risk' | 'behind' | 'achieved' {
    const now = new Date();
    const { endDate } = this.getMonthDates(month);
    const isPastMonth = now > endDate;

    let achievedCount = 0;
    let atRiskCount = 0;
    const totalMetrics = Object.keys(targets).length;

    for (const key of Object.keys(targets)) {
      const target = targets[key];
      const current = achieved[key] || 0;
      const percentage = target > 0 ? (current / target) * 100 : 0;

      if (percentage >= 100) {
        achievedCount++;
      } else if (percentage >= 80) {
        atRiskCount++;
      }
    }

    if (isPastMonth) {
      // Mes pasado: achieved si cumplió todos, behind si no
      return achievedCount === totalMetrics ? 'achieved' : 'behind';
    }

    // Mes actual
    if (achievedCount === totalMetrics) {
      return 'achieved';
    } else if (achievedCount + atRiskCount >= totalMetrics * 0.7) {
      return 'on_track';
    } else if (achievedCount + atRiskCount >= totalMetrics * 0.4) {
      return 'at_risk';
    }
    return 'behind';
  }

  private getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  private getMonthDates(month: string): { startDate: Date; endDate: Date } {
    const [year, monthNum] = month.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1, 0, 0, 0);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59);
    return { startDate, endDate };
  }

  private getMonthProgress(month: string): {
    daysElapsed: number;
    daysRemaining: number;
    totalDays: number;
  } {
    const { startDate, endDate } = this.getMonthDates(month);
    const now = new Date();
    const totalDays = endDate.getDate();

    // Si el mes ya pasó, todo está transcurrido
    if (now > endDate) {
      return { daysElapsed: totalDays, daysRemaining: 0, totalDays };
    }

    // Si el mes no ha empezado, nada está transcurrido
    if (now < startDate) {
      return { daysElapsed: 0, daysRemaining: totalDays, totalDays };
    }

    const daysElapsed = now.getDate();
    const daysRemaining = totalDays - daysElapsed;

    return { daysElapsed, daysRemaining, totalDays };
  }
}
