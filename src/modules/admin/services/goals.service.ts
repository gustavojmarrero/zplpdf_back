import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { FirestoreService } from '../../cache/firestore.service.js';
import { ExchangeRateService } from './exchange-rate.service.js';
import type { MonthlyGoal, GoalTargets, GoalAlerts } from '../../../common/interfaces/finance.interface.js';

export interface SetGoalsDto {
  month: string; // YYYY-MM
  targets: GoalTargets;
}

export interface GoalProgress {
  month: string;
  targets: GoalTargets;
  actual: GoalTargets;
  progress: {
    revenue: number; // Porcentaje
    newUsers: number;
    proConversions: number;
  };
  daysRemaining: number;
  daysElapsed: number;
  expectedPace: GoalTargets; // Lo que deberías tener a este ritmo
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

    // Validar targets
    if (data.targets.revenue < 0 || data.targets.newUsers < 0 || data.targets.proConversions < 0) {
      throw new BadRequestException('Targets must be non-negative');
    }

    const goalId = `goal_${data.month.replace(/-/g, '')}`;
    const now = new Date();

    // Verificar si ya existe un objetivo para este mes
    const existing = await this.firestoreService.getGoal(data.month);

    const goal: MonthlyGoal = {
      id: goalId,
      month: data.month,
      targets: data.targets,
      actual: existing?.actual || { revenue: 0, newUsers: 0, proConversions: 0 },
      alerts: existing?.alerts,
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
    const actual = await this.calculateActuals(targetMonth);

    // Calcular ritmo esperado
    const paceMultiplier = daysElapsed / totalDays;
    const expectedPace: GoalTargets = {
      revenue: goal.targets.revenue * paceMultiplier,
      newUsers: goal.targets.newUsers * paceMultiplier,
      proConversions: goal.targets.proConversions * paceMultiplier,
    };

    // Calcular porcentajes de progreso
    const progress = {
      revenue: goal.targets.revenue > 0 ? (actual.revenue / goal.targets.revenue) * 100 : 0,
      newUsers: goal.targets.newUsers > 0 ? (actual.newUsers / goal.targets.newUsers) * 100 : 0,
      proConversions:
        goal.targets.proConversions > 0
          ? (actual.proConversions / goal.targets.proConversions) * 100
          : 0,
    };

    // Calcular alertas
    const alerts: GoalAlerts = {
      belowPaceRevenue: actual.revenue < expectedPace.revenue * this.ALERT_THRESHOLD,
      belowPaceUsers: actual.newUsers < expectedPace.newUsers * this.ALERT_THRESHOLD,
      belowPaceConversions:
        actual.proConversions < expectedPace.proConversions * this.ALERT_THRESHOLD,
    };

    // Determinar estado general
    const alertCount = Object.values(alerts).filter(Boolean).length;
    let status: 'on_track' | 'at_risk' | 'behind';
    if (alertCount === 0) {
      status = 'on_track';
    } else if (alertCount <= 1) {
      status = 'at_risk';
    } else {
      status = 'behind';
    }

    return {
      month: targetMonth,
      targets: goal.targets,
      actual,
      progress: {
        revenue: Math.round(progress.revenue * 100) / 100,
        newUsers: Math.round(progress.newUsers * 100) / 100,
        proConversions: Math.round(progress.proConversions * 100) / 100,
      },
      daysRemaining,
      daysElapsed,
      expectedPace: {
        revenue: Math.round(expectedPace.revenue * 100) / 100,
        newUsers: Math.round(expectedPace.newUsers),
        proConversions: Math.round(expectedPace.proConversions),
      },
      alerts,
      status,
    };
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

    const actual = await this.calculateActuals(currentMonth);

    // Calcular alertas
    const { daysElapsed, totalDays } = this.getMonthProgress(currentMonth);
    const paceMultiplier = daysElapsed / totalDays;
    const expectedPace: GoalTargets = {
      revenue: goal.targets.revenue * paceMultiplier,
      newUsers: goal.targets.newUsers * paceMultiplier,
      proConversions: goal.targets.proConversions * paceMultiplier,
    };

    const alerts: GoalAlerts = {
      belowPaceRevenue: actual.revenue < expectedPace.revenue * this.ALERT_THRESHOLD,
      belowPaceUsers: actual.newUsers < expectedPace.newUsers * this.ALERT_THRESHOLD,
      belowPaceConversions:
        actual.proConversions < expectedPace.proConversions * this.ALERT_THRESHOLD,
    };

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
      if (progress.alerts.belowPaceRevenue) {
        alertMessages.push('ingresos');
      }
      if (progress.alerts.belowPaceUsers) {
        alertMessages.push('nuevos usuarios');
      }
      if (progress.alerts.belowPaceConversions) {
        alertMessages.push('conversiones Pro');
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
    } catch (error) {
      return {
        month: currentMonth,
        alerts: { belowPaceRevenue: false, belowPaceUsers: false, belowPaceConversions: false },
        hasAlerts: false,
        summary: 'No hay objetivos configurados para este mes',
      };
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  private async calculateActuals(month: string): Promise<GoalTargets> {
    const { startDate, endDate } = this.getMonthDates(month);

    // Obtener métricas del mes
    const [revenueData, newUsers, proConversions] = await Promise.all([
      this.firestoreService.getRevenueByPeriod(startDate, endDate),
      this.firestoreService.getNewUsersInPeriod(startDate, endDate),
      this.firestoreService.getProConversionsInPeriod(startDate, endDate),
    ]);

    // Convertir ingresos USD a MXN
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

    return {
      revenue: revenueMxn,
      newUsers,
      proConversions,
    };
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
