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

// Mapa de códigos ISO a nombres de países
const COUNTRY_NAMES: Record<string, string> = {
  MX: 'México',
  US: 'United States',
  BR: 'Brasil',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  PE: 'Perú',
  EC: 'Ecuador',
  VE: 'Venezuela',
  UY: 'Uruguay',
  PY: 'Paraguay',
  BO: 'Bolivia',
  CR: 'Costa Rica',
  PA: 'Panamá',
  GT: 'Guatemala',
  HN: 'Honduras',
  SV: 'El Salvador',
  NI: 'Nicaragua',
  DO: 'República Dominicana',
  PR: 'Puerto Rico',
  ES: 'España',
  CA: 'Canada',
  GB: 'United Kingdom',
  DE: 'Germany',
  FR: 'France',
  IT: 'Italy',
  PT: 'Portugal',
};

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
    byCurrency: {
      usd: { amount: number; amountMxn: number; transactions: number };
      mxn: { amount: number; amountMxn: number; transactions: number };
    };
    byCountry: Array<{
      country: string;
      countryName: string;
      amount: number;
      transactions: number;
    }>;
  }> {
    // Obtener transacciones del período
    const { transactions } = await this.firestoreService.getTransactions({
      startDate,
      endDate,
      status: 'succeeded',
      limit: 1000,
    });

    // Calcular por moneda
    const byCurrency = {
      usd: { amount: 0, amountMxn: 0, transactions: 0 },
      mxn: { amount: 0, amountMxn: 0, transactions: 0 },
    };

    const countryMap = new Map<string, { amount: number; transactions: number }>();

    for (const tx of transactions) {
      const curr = tx.currency as 'usd' | 'mxn';
      if (curr === 'usd' || curr === 'mxn') {
        byCurrency[curr].amount += (tx.amount || 0) / 100;
        byCurrency[curr].amountMxn += tx.amountMxn || (tx.amount || 0) / 100;
        byCurrency[curr].transactions++;
      }

      // Agregar a byCountry
      const country = tx.billingCountry || 'Unknown';
      if (!countryMap.has(country)) {
        countryMap.set(country, { amount: 0, transactions: 0 });
      }
      const countryData = countryMap.get(country)!;
      countryData.amount += (tx.amount || 0) / 100;
      countryData.transactions++;
    }

    // Convertir mapa a array con nombres de países
    const byCountry = Array.from(countryMap.entries())
      .map(([country, data]) => ({
        country,
        countryName: COUNTRY_NAMES[country] || country,
        amount: data.amount,
        transactions: data.transactions,
      }))
      .sort((a, b) => b.amount - a.amount);

    return { byCurrency, byCountry };
  }

  /**
   * Obtiene historial de MRR por mes
   * Retorna objeto con history y current para el frontend
   */
  async getMRRHistory(months: number = 12): Promise<{
    history: Array<{ month: string; mrr: number; mrrUsd: number }>;
    current: { mrr: number; subscriberCount: number };
  }> {
    const historyItems: MRRHistoryItem[] = [];
    const now = new Date();

    // Obtener tipo de cambio para conversión
    let exchangeRate = 20;
    try {
      exchangeRate = await this.exchangeRateService.getExchangeRate(this.firestoreService);
    } catch {
      // Usar tasa por defecto
    }

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

      historyItems.push({
        month: monthStr,
        mrr,
        mrrMxn: mrr,
        subscribers: subscribers.size,
        newMrr,
        churnedMrr,
      });
    }

    // Obtener datos actuales
    const activeSubscribers = await this.firestoreService.getActiveSubscribersCount();
    const currentRevenue = await this.getRevenue('month');

    // Formatear respuesta para el frontend
    return {
      history: historyItems.reverse().map((h) => ({
        month: h.month,
        mrr: h.mrrMxn,
        mrrUsd: h.mrrMxn / exchangeRate,
      })),
      current: {
        mrr: currentRevenue.mrrMxn,
        subscriberCount: activeSubscribers,
      },
    };
  }

  /**
   * Obtiene tasa de churn por período
   */
  async getChurnRate(
    period: 'day' | 'week' | 'month' | 'quarter' | 'year' = 'month',
  ): Promise<ChurnData> {
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
    const trend: Array<{ month: string; churnRate: number }> = [];
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
        churnRate: Math.round(monthRate * 100) / 100,
      });
    }

    return {
      period: period,
      churnRate: Math.round(churnRate * 100) / 100,
      churnedUsers,
      totalSubscribers: activeSubscribers,
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
    mrr: {
      current: number;
      subscriberCount: number;
      history: Array<{ month: string; mrr: number; mrrUsd: number }>;
    };
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
    const [revenue, mrrData, churn, ltv, profit, subscribers] = await Promise.all([
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
        current: mrrData.current.mrr,
        subscriberCount: mrrData.current.subscriberCount,
        history: mrrData.history,
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
