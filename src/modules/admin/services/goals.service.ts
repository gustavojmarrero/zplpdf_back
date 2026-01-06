import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { FirestoreService } from '../../cache/firestore.service.js';
import { ExchangeRateService } from './exchange-rate.service.js';
import {
  getCurrentMonthInTimezone,
  getMonthDatesInTimezone,
  getCurrentDayInTimezone,
} from '../../../utils/timezone.util.js';
import type {
  MonthlyGoal,
  GoalTargets,
  GoalAlerts,
  GoalMetricConfig,
  GoalHistoryItem,
  MetricBehavior,
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

    // Calcular baseline para métricas acumulativas
    // Si ya existe la meta, preservar el baseline original
    const baseline = existing?.baseline || (await this.getBaselineForMonth(data.month, Object.keys(data.targets)));

    const goal: MonthlyGoal = {
      id: goalId,
      month: data.month,
      targets: data.targets,
      baseline,
      actual: initialActual,
      metrics,
      alerts: existing?.alerts || {},
      createdBy: adminEmail,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    await this.firestoreService.saveGoal(goal);
    this.logger.log(`Set goals for ${data.month}: ${JSON.stringify(data.targets)}, baseline: ${JSON.stringify(baseline)}`);

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

    // Si no hay baseline guardado, calcularlo (retrocompatibilidad)
    // Verificar si el objeto baseline tiene keys, no solo si existe
    const hasBaseline = goal.baseline && Object.keys(goal.baseline).length > 0;
    const baseline = hasBaseline ? goal.baseline : await this.getBaselineForMonth(targetMonth, Object.keys(goal.targets));

    // Calcular ritmo esperado según tipo de métrica
    const paceMultiplier = daysElapsed / totalDays;
    const expectedPace: GoalTargets = {};
    for (const key of Object.keys(goal.targets)) {
      const metric = metrics.find((m) => m.key === key);
      const behavior = metric?.behavior || this.inferBehavior(key);
      const target = goal.targets[key];
      const baselineValue = baseline[key] || 0;

      switch (behavior) {
        case 'cumulative':
          // Para métricas acumulativas: baseline + (delta * progreso)
          const delta = target - baselineValue;
          expectedPace[key] = baselineValue + delta * paceMultiplier;
          break;
        case 'point_in_time':
          // Para porcentajes: la meta es el valor objetivo (no prorratea)
          expectedPace[key] = target;
          break;
        case 'monthly':
        default:
          // Para métricas mensuales: prorratea desde 0
          expectedPace[key] = target * paceMultiplier;
          break;
      }
    }

    // Calcular porcentajes de progreso basado en el tipo de métrica
    const progress: Record<string, number> = {};
    for (const key of Object.keys(goal.targets)) {
      const target = goal.targets[key];
      const currentValue = current[key] || 0;
      const baselineValue = baseline[key] || 0;
      const metric = metrics.find((m) => m.key === key);
      const behavior = metric?.behavior || this.inferBehavior(key);

      if (behavior === 'cumulative' && target > baselineValue) {
        // Progreso = (actual - baseline) / (target - baseline)
        const deltaAchieved = currentValue - baselineValue;
        const deltaRequired = target - baselineValue;
        progress[key] = deltaRequired > 0 ? Math.round((deltaAchieved / deltaRequired) * 10000) / 100 : 0;
      } else {
        // Métricas mensuales y point_in_time: progreso normal
        progress[key] = target > 0 ? Math.round((currentValue / target) * 10000) / 100 : 0;
      }
    }

    // Calcular alertas basadas en el comportamiento correcto
    const alerts: GoalAlerts = {};
    for (const key of Object.keys(goal.targets)) {
      const currentValue = current[key] || 0;
      const expectedValue = expectedPace[key] || 0;
      const metric = metrics.find((m) => m.key === key);
      const behavior = metric?.behavior || this.inferBehavior(key);

      if (behavior === 'point_in_time') {
        // Para métricas puntuales, comparar con la meta directa
        alerts[`belowPace_${key}`] = currentValue < goal.targets[key] * this.ALERT_THRESHOLD;
      } else {
        // Para todas las demás, comparar con expectedPace
        alerts[`belowPace_${key}`] = currentValue < expectedValue * this.ALERT_THRESHOLD;
      }
    }

    // Determinar estado general (excluir métricas sin datos disponibles)
    // Una métrica "sin datos" tiene current=0 y target>0
    const metricsWithData = Object.keys(goal.targets).filter((key) => {
      const currentValue = current[key] || 0;
      const targetValue = goal.targets[key] || 0;
      // Incluir si tiene datos (current > 0) o si la meta es 0
      return currentValue > 0 || targetValue === 0;
    });

    const relevantAlertCount = metricsWithData.filter((key) => alerts[`belowPace_${key}`]).length;
    const totalRelevantMetrics = metricsWithData.length;

    let status: 'on_track' | 'at_risk' | 'behind';
    if (relevantAlertCount === 0) {
      status = 'on_track';
    } else if (totalRelevantMetrics > 0 && relevantAlertCount <= Math.ceil(totalRelevantMetrics / 3)) {
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
    const metrics = goal.metrics || this.getRelevantDefaultMetrics(metricKeys);

    // Si no hay baseline guardado, calcularlo (retrocompatibilidad)
    const hasBaseline = goal.baseline && Object.keys(goal.baseline).length > 0;
    const baseline = hasBaseline ? goal.baseline : await this.getBaselineForMonth(currentMonth, metricKeys);

    // Calcular alertas con la lógica correcta según tipo de métrica
    const { daysElapsed, totalDays } = this.getMonthProgress(currentMonth);
    const paceMultiplier = daysElapsed / totalDays;

    const alerts: GoalAlerts = {};
    for (const key of metricKeys) {
      const metric = metrics.find((m) => m.key === key);
      const behavior = metric?.behavior || this.inferBehavior(key);
      const target = goal.targets[key];
      const baselineValue = baseline[key] || 0;
      const currentValue = actual[key] || 0;

      let expectedValue: number;
      switch (behavior) {
        case 'cumulative':
          const delta = target - baselineValue;
          expectedValue = baselineValue + delta * paceMultiplier;
          break;
        case 'point_in_time':
          expectedValue = target;
          break;
        case 'monthly':
        default:
          expectedValue = target * paceMultiplier;
          break;
      }

      if (behavior === 'point_in_time') {
        alerts[`belowPace_${key}`] = currentValue < target * this.ALERT_THRESHOLD;
      } else {
        alerts[`belowPace_${key}`] = currentValue < expectedValue * this.ALERT_THRESHOLD;
      }
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
    // NOTA: newUsers y proConversions son TOTALES acumulados, no del período
    const [revenueData, totalUsers, usersByPlan, expenseSummary] = await Promise.all([
      this.firestoreService.getRevenueByPeriod(startDate, endDate), // Revenue del mes
      this.firestoreService.getUsersCount(), // Total usuarios actuales
      this.firestoreService.getUsersByPlan(), // { free, pro, enterprise }
      this.firestoreService.getExpenseSummary(startDate, endDate), // Gastos del mes
    ]);

    // Calcular revenue en USD (convertir MXN a USD si es necesario)
    let revenueUsd = revenueData.totalUsd;
    if (revenueData.totalMxn > 0) {
      try {
        // Obtener tipo de cambio y convertir MXN a USD
        const rate = await this.exchangeRateService.getExchangeRate(this.firestoreService);
        revenueUsd += revenueData.totalMxn / rate;
      } catch {
        revenueUsd += revenueData.totalMxn / 20; // Fallback rate
      }
    }

    // Total de suscriptores de pago (pro + promax + enterprise)
    const totalProSubscribers = usersByPlan.pro + usersByPlan.promax + usersByPlan.enterprise;

    // Mapear métricas disponibles
    for (const key of metricKeys) {
      switch (key) {
        case 'revenue':
          // Revenue en USD (redondear a 2 decimales)
          actual[key] = Math.round(revenueUsd * 100) / 100;
          break;
        case 'newUsers':
          // Total de usuarios registrados (meta acumulada, no del período)
          actual[key] = totalUsers;
          break;
        case 'proConversions':
          // Total de suscriptores Pro actuales (meta acumulada, no del período)
          actual[key] = totalProSubscribers;
          break;
        case 'conversionRate':
          // Tasa de conversión = (suscriptores pro / total usuarios) * 100
          actual[key] = totalUsers > 0 ? Math.round((totalProSubscribers / totalUsers) * 10000) / 100 : 0;
          break;
        case 'profit':
          // Utilidad en USD = Ingresos USD - Gastos convertidos a USD
          const expensesUsd = expenseSummary.totalMxn / 20; // Aproximación, los gastos están en MXN
          actual[key] = Math.round((revenueUsd - expensesUsd) * 100) / 100;
          break;
        case 'adsSpend':
          // Gastos en advertising del mes (convertir de MXN a USD)
          const adsInMxn = expenseSummary.byCategory?.advertising || 0;
          actual[key] = Math.round((adsInMxn / 20) * 100) / 100;
          break;
        case 'traffic':
        case 'cac':
          // Estas métricas requieren datos externos
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
    return getCurrentMonthInTimezone();
  }

  private getMonthDates(month: string): { startDate: Date; endDate: Date } {
    return getMonthDatesInTimezone(month);
  }

  private getMonthProgress(month: string): {
    daysElapsed: number;
    daysRemaining: number;
    totalDays: number;
  } {
    const { startDate, endDate } = this.getMonthDates(month);
    const now = new Date();

    // Calcular total de días en el mes
    const [year, monthNum] = month.split('-').map(Number);
    const totalDays = new Date(year, monthNum, 0).getDate();

    // Si el mes ya pasó, todo está transcurrido
    if (now > endDate) {
      return { daysElapsed: totalDays, daysRemaining: 0, totalDays };
    }

    // Si el mes no ha empezado, nada está transcurrido
    if (now < startDate) {
      return { daysElapsed: 0, daysRemaining: totalDays, totalDays };
    }

    // Obtener día actual en GMT-6
    const daysElapsed = getCurrentDayInTimezone(now);
    const daysRemaining = totalDays - daysElapsed;

    return { daysElapsed, daysRemaining, totalDays };
  }

  /**
   * Infiere el comportamiento de una métrica basado en su key
   */
  private inferBehavior(key: string): MetricBehavior {
    const cumulativeMetrics = ['newUsers', 'proConversions'];
    const pointInTimeMetrics = ['conversionRate'];

    if (cumulativeMetrics.includes(key)) return 'cumulative';
    if (pointInTimeMetrics.includes(key)) return 'point_in_time';
    return 'monthly';
  }

  /**
   * Obtiene el baseline para un mes específico
   * Para métricas acumulativas: usa el target del mes anterior
   * Para enero 2026 (primer mes): usa valores hardcodeados
   */
  private async getBaselineForMonth(month: string, metricKeys: string[]): Promise<GoalTargets> {
    const baseline: GoalTargets = {};

    // Obtener mes anterior
    const [year, monthNum] = month.split('-').map(Number);
    const prevDate = new Date(year, monthNum - 2, 1); // -2 porque monthNum es 1-based
    const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

    // Buscar meta del mes anterior
    const prevGoal = await this.firestoreService.getGoal(prevMonth);

    for (const key of metricKeys) {
      const behavior = this.inferBehavior(key);

      if (behavior === 'cumulative') {
        if (prevGoal?.targets?.[key]) {
          // Usar target del mes anterior como baseline
          baseline[key] = prevGoal.targets[key];
        } else {
          // Primer mes o no hay meta anterior: usar hardcoded para enero 2026
          if (month === '2026-01') {
            baseline[key] = key === 'newUsers' ? 283 : key === 'proConversions' ? 22 : 0;
          } else {
            baseline[key] = 0; // Fallback
          }
        }
      }
      // Métricas mensuales no necesitan baseline (empiezan de 0)
    }

    return baseline;
  }
}
