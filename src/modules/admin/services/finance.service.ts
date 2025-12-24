import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../../cache/firestore.service.js';
import { ExchangeRateService } from './exchange-rate.service.js';
import type {
  RevenueData,
  MRRHistoryItem,
  ChurnData,
  LTVData,
  ProfitData,
  StripeTransaction,
} from '../../../common/interfaces/finance.interface.js';

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  // Cache en memoria para métricas (5 minutos)
  private metricsCache: { data: any; cachedAt: Date } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * Obtiene métricas de ingresos por período
   */
  async getRevenue(period: 'day' | 'week' | 'month' | 'year' = 'month'): Promise<RevenueData> {
    const { startDate, endDate } = this.getPeriodDates(period);
    const { previousStartDate, previousEndDate } = this.getPreviousPeriodDates(period);

    // Obtener ingresos del período actual
    const currentRevenue = await this.firestoreService.getRevenueByPeriod(startDate, endDate);

    // Obtener ingresos del período anterior para calcular crecimiento
    const previousRevenue = await this.firestoreService.getRevenueByPeriod(
      previousStartDate,
      previousEndDate,
    );

    // Convertir USD a MXN para el total
    let totalMxn = currentRevenue.totalMxn;
    let exchangeRate = 1;

    if (currentRevenue.totalUsd > 0) {
      try {
        const conversion = await this.exchangeRateService.convertUsdToMxn(
          currentRevenue.totalUsd,
          this.firestoreService,
        );
        totalMxn += conversion.amountMxn;
        exchangeRate = conversion.rate;
      } catch (error) {
        this.logger.warn(`Failed to convert USD to MXN: ${error.message}`);
        totalMxn += currentRevenue.totalUsd * 20; // Fallback rate
      }
    }

    // Calcular MRR (solo suscripciones activas)
    const activeSubscribers = await this.firestoreService.getActiveSubscribersCount();
    const avgMrr = activeSubscribers > 0 ? totalMxn / activeSubscribers : 0;
    const mrr = avgMrr * activeSubscribers;

    // Calcular crecimiento vs período anterior
    const previousTotalMxn = previousRevenue.totalMxn + previousRevenue.totalUsd * exchangeRate;
    const growth = previousTotalMxn > 0 ? ((totalMxn - previousTotalMxn) / previousTotalMxn) * 100 : 0;

    return {
      total: currentRevenue.totalUsd + currentRevenue.totalMxn,
      totalMxn,
      byCurrency: {
        usd: currentRevenue.totalUsd,
        mxn: currentRevenue.totalMxn,
      },
      mrr,
      mrrMxn: mrr,
      growth: Math.round(growth * 100) / 100,
      transactionCount: currentRevenue.count,
    };
  }

  /**
   * Obtiene desglose de ingresos por moneda y país
   */
  async getRevenueBreakdown(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    byCurrency: { usd: number; mxn: number };
    byCountry: Array<{ country: string; revenue: number; revenueMxn: number; transactions: number }>;
    transactions: StripeTransaction[];
    total: number;
  }> {
    const revenue = await this.firestoreService.getRevenueByPeriod(startDate, endDate);
    const revenueByCountry = await this.firestoreService.getRevenueByCountry(startDate, endDate);
    const { transactions } = await this.firestoreService.getTransactions({
      startDate,
      endDate,
      status: 'succeeded',
      limit: 100,
    });

    return {
      byCurrency: {
        usd: revenue.totalUsd,
        mxn: revenue.totalMxn,
      },
      byCountry: revenueByCountry,
      transactions,
      total: revenue.count,
    };
  }

  /**
   * Obtiene historial de MRR por mes
   */
  async getMRRHistory(months: number = 12): Promise<MRRHistoryItem[]> {
    const history: MRRHistoryItem[] = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthStr = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;

      // Obtener eventos de suscripción del mes
      const events = await this.firestoreService.getSubscriptionEvents({
        startDate: monthDate,
        endDate: monthEnd,
      });

      let newMrr = 0;
      let churnedMrr = 0;
      const subscribers = new Set<string>();

      for (const event of events) {
        if (event.eventType === 'started') {
          newMrr += event.mrrMxn;
          subscribers.add(event.userId);
        } else if (event.eventType === 'canceled' || event.eventType === 'churned') {
          churnedMrr += event.mrrMxn;
        }
      }

      // Calcular MRR del mes
      const revenue = await this.firestoreService.getRevenueByPeriod(monthDate, monthEnd);
      let mrr = revenue.totalMxn;

      if (revenue.totalUsd > 0) {
        try {
          const conversion = await this.exchangeRateService.convertUsdToMxn(
            revenue.totalUsd,
            this.firestoreService,
          );
          mrr += conversion.amountMxn;
        } catch {
          mrr += revenue.totalUsd * 20;
        }
      }

      history.push({
        month: monthStr,
        mrr,
        mrrMxn: mrr,
        subscribers: subscribers.size,
        newMrr,
        churnedMrr,
      });
    }

    return history.reverse();
  }

  /**
   * Obtiene tasa de churn por período
   */
  async getChurnRate(period: 'month' | 'quarter' | 'year' = 'month'): Promise<ChurnData> {
    const { startDate, endDate } = this.getPeriodDates(period);

    // Obtener usuarios churneados en el período
    const churnedUsers = await this.firestoreService.getChurnedUsersInPeriod(startDate, endDate);

    // Obtener suscriptores activos al inicio del período
    const activeSubscribers = await this.firestoreService.getActiveSubscribersCount();

    // Calcular churn rate
    const totalSubscribersAtStart = activeSubscribers + churnedUsers;
    const churnRate =
      totalSubscribersAtStart > 0 ? (churnedUsers / totalSubscribersAtStart) * 100 : 0;

    // Obtener eventos de cancelación para MRR churneado
    const cancelEvents = await this.firestoreService.getSubscriptionEvents({
      startDate,
      endDate,
      eventType: 'canceled',
    });

    let churnedMrr = 0;
    let churnedMrrMxn = 0;

    for (const event of cancelEvents) {
      churnedMrr += event.mrr;
      churnedMrrMxn += event.mrrMxn;
    }

    // Tendencia de churn de los últimos 6 meses
    const trend: Array<{ month: string; rate: number }> = [];
    const now = new Date();

    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthStr = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;

      const monthChurned = await this.firestoreService.getChurnedUsersInPeriod(monthDate, monthEnd);
      const monthActive = await this.firestoreService.getActiveSubscribersCount();
      const monthTotal = monthActive + monthChurned;
      const monthRate = monthTotal > 0 ? (monthChurned / monthTotal) * 100 : 0;

      trend.push({
        month: monthStr,
        rate: Math.round(monthRate * 100) / 100,
      });
    }

    return {
      period: period,
      churnRate: Math.round(churnRate * 100) / 100,
      churnedUsers,
      churnedMrr,
      churnedMrrMxn,
      trend,
    };
  }

  /**
   * Obtiene Lifetime Value promedio
   */
  async getLTV(): Promise<LTVData> {
    // Obtener todos los eventos de suscripción
    const events = await this.firestoreService.getSubscriptionEvents({});

    const userMrr = new Map<string, { total: number; months: number; plan: string }>();

    for (const event of events) {
      if (!userMrr.has(event.userId)) {
        userMrr.set(event.userId, { total: 0, months: 0, plan: event.plan });
      }

      const userData = userMrr.get(event.userId)!;

      if (event.eventType === 'started' || event.eventType === 'renewed') {
        userData.total += event.mrrMxn;
        userData.months++;
        userData.plan = event.plan;
      }
    }

    let totalLtv = 0;
    let totalMonths = 0;
    let userCount = 0;
    const byPlan = {
      pro: { ltv: 0, avgMonths: 0, count: 0 },
      enterprise: { ltv: 0, avgMonths: 0, count: 0 },
    };

    for (const [, data] of userMrr) {
      if (data.months > 0) {
        const userLtv = data.total;
        totalLtv += userLtv;
        totalMonths += data.months;
        userCount++;

        if (data.plan === 'pro' || data.plan === 'enterprise') {
          byPlan[data.plan].ltv += userLtv;
          byPlan[data.plan].avgMonths += data.months;
          byPlan[data.plan].count++;
        }
      }
    }

    const avgLtv = userCount > 0 ? totalLtv / userCount : 0;
    const avgMonths = userCount > 0 ? totalMonths / userCount : 0;

    // Calcular promedios por plan
    for (const plan of ['pro', 'enterprise'] as const) {
      if (byPlan[plan].count > 0) {
        byPlan[plan].ltv = byPlan[plan].ltv / byPlan[plan].count;
        byPlan[plan].avgMonths = byPlan[plan].avgMonths / byPlan[plan].count;
      }
    }

    // Convertir LTV a USD (aproximado)
    const exchangeRate = await this.exchangeRateService.getExchangeRate(this.firestoreService);

    return {
      avgLtv: avgLtv / exchangeRate,
      avgLtvMxn: avgLtv,
      avgSubscriptionMonths: Math.round(avgMonths * 10) / 10,
      byPlan: {
        pro: {
          ltv: byPlan.pro.ltv / exchangeRate,
          avgMonths: Math.round(byPlan.pro.avgMonths * 10) / 10,
        },
        enterprise: {
          ltv: byPlan.enterprise.ltv / exchangeRate,
          avgMonths: Math.round(byPlan.enterprise.avgMonths * 10) / 10,
        },
      },
    };
  }

  /**
   * Obtiene margen de ganancia (ingresos - gastos)
   */
  async getProfitMargin(period: 'month' | 'quarter' | 'year' = 'month'): Promise<ProfitData> {
    const { startDate, endDate } = this.getPeriodDates(period);

    // Obtener ingresos
    const revenue = await this.firestoreService.getRevenueByPeriod(startDate, endDate);
    let revenueMxn = revenue.totalMxn;

    if (revenue.totalUsd > 0) {
      try {
        const conversion = await this.exchangeRateService.convertUsdToMxn(
          revenue.totalUsd,
          this.firestoreService,
        );
        revenueMxn += conversion.amountMxn;
      } catch {
        revenueMxn += revenue.totalUsd * 20;
      }
    }

    // Obtener gastos
    const expenseSummary = await this.firestoreService.getExpenseSummary(startDate, endDate);

    // Calcular profit
    const profitMxn = revenueMxn - expenseSummary.totalMxn;
    const profitMargin = revenueMxn > 0 ? (profitMxn / revenueMxn) * 100 : 0;

    // Convertir a USD
    const exchangeRate = await this.exchangeRateService.getExchangeRate(this.firestoreService);

    return {
      period,
      revenue: revenueMxn / exchangeRate,
      revenueMxn,
      expenses: expenseSummary.totalMxn / exchangeRate,
      expensesMxn: expenseSummary.totalMxn,
      profit: profitMxn / exchangeRate,
      profitMxn,
      profitMargin: Math.round(profitMargin * 100) / 100,
    };
  }

  /**
   * Dashboard financiero consolidado
   */
  async getFinancialDashboard(): Promise<{
    revenue: RevenueData;
    mrr: { current: number; history: MRRHistoryItem[] };
    churn: ChurnData;
    ltv: LTVData;
    profit: ProfitData;
    subscribers: number;
  }> {
    // Verificar cache
    if (this.metricsCache && Date.now() - this.metricsCache.cachedAt.getTime() < this.CACHE_TTL_MS) {
      this.logger.debug('Returning cached financial dashboard');
      return this.metricsCache.data;
    }

    // Ejecutar consultas en paralelo
    const [revenue, mrrHistory, churn, ltv, profit, subscribers] = await Promise.all([
      this.getRevenue('month'),
      this.getMRRHistory(6),
      this.getChurnRate('month'),
      this.getLTV(),
      this.getProfitMargin('month'),
      this.firestoreService.getActiveSubscribersCount(),
    ]);

    const dashboard = {
      revenue,
      mrr: {
        current: revenue.mrr,
        history: mrrHistory,
      },
      churn,
      ltv,
      profit,
      subscribers,
    };

    // Guardar en cache
    this.metricsCache = {
      data: dashboard,
      cachedAt: new Date(),
    };

    return dashboard;
  }

  // ============================================
  // Helper Methods
  // ============================================

  private getPeriodDates(period: 'day' | 'week' | 'month' | 'quarter' | 'year'): {
    startDate: Date;
    endDate: Date;
  } {
    const now = new Date();
    const endDate = new Date(now);

    let startDate: Date;

    switch (period) {
      case 'day':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'quarter':
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    return { startDate, endDate };
  }

  private getPreviousPeriodDates(period: 'day' | 'week' | 'month' | 'quarter' | 'year'): {
    previousStartDate: Date;
    previousEndDate: Date;
  } {
    const { startDate, endDate } = this.getPeriodDates(period);
    const periodMs = endDate.getTime() - startDate.getTime();

    return {
      previousStartDate: new Date(startDate.getTime() - periodMs),
      previousEndDate: new Date(startDate.getTime() - 1),
    };
  }
}
