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
  BusinessValuationData,
  ValuationFactors,
  ValuationSnapshot,
  ValuationRange,
  PreviousMonthComparison,
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
      promax: { ltv: 0, avgMonths: 0, count: 0 },
      enterprise: { ltv: 0, avgMonths: 0, count: 0 },
    };

    for (const [, data] of userMrr) {
      if (data.months > 0) {
        const userLtv = data.total;
        totalLtv += userLtv;
        totalMonths += data.months;
        userCount++;

        if (data.plan === 'pro' || data.plan === 'promax' || data.plan === 'enterprise') {
          byPlan[data.plan].ltv += userLtv;
          byPlan[data.plan].avgMonths += data.months;
          byPlan[data.plan].count++;
        }
      }
    }

    const avgLtv = userCount > 0 ? totalLtv / userCount : 0;
    const avgMonths = userCount > 0 ? totalMonths / userCount : 0;

    // Calcular promedios por plan
    for (const plan of ['pro', 'promax', 'enterprise'] as const) {
      if (byPlan[plan].count > 0) {
        byPlan[plan].ltv = byPlan[plan].ltv / byPlan[plan].count;
        byPlan[plan].avgMonths = byPlan[plan].avgMonths / byPlan[plan].count;
      }
    }

    // Convertir LTV a USD (aproximado)
    const exchangeRate = await this.exchangeRateService.getExchangeRate(this.firestoreService);

    // Calcular ingreso mensual promedio (LTV / meses de suscripción)
    const avgMonthlyRevenue = avgMonths > 0 ? (avgLtv / avgMonths) / exchangeRate : 0;

    // Obtener total de suscriptores activos (misma fuente que churn)
    const totalCustomers = await this.firestoreService.getActiveSubscribersCount();

    return {
      avgLtv: avgLtv / exchangeRate,
      avgLtvMxn: avgLtv,
      avgSubscriptionMonths: Math.round(avgMonths * 10) / 10,
      totalCustomers,
      avgMonthlyRevenue: Math.round(avgMonthlyRevenue * 100) / 100,
      byPlan: {
        pro: {
          ltv: byPlan.pro.ltv / exchangeRate,
          avgMonths: Math.round(byPlan.pro.avgMonths * 10) / 10,
        },
        promax: {
          ltv: byPlan.promax.ltv / exchangeRate,
          avgMonths: Math.round(byPlan.promax.avgMonths * 10) / 10,
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

  // ============================================
  // Business Valuation Methods
  // ============================================

  /**
   * Calcula la valoración del negocio usando metodología Revenue Multiple
   * Múltiplo dinámico basado en métricas reales del SaaS
   */
  async getBusinessValuation(): Promise<BusinessValuationData> {
    this.logger.log('Calculating business valuation...');

    // 1. Obtener métricas base en paralelo
    const [mrrHistory, churnData, profit, exchangeRate, previousValuations] = await Promise.all([
      this.getMRRHistory(12),
      this.getChurnRate('month'),
      this.getProfitMargin('month'),
      this.exchangeRateService.getExchangeRate(this.firestoreService),
      this.firestoreService.getValuationHistory(1),
    ]);

    // 2. Calcular MRR y ARR
    const mrrMxn = mrrHistory.current.mrr;
    const mrrUsd = mrrMxn / exchangeRate;
    const arrMxn = mrrMxn * 12;
    const arrUsd = mrrUsd * 12;

    // 3. Calcular Growth Rate anual
    const growthRate = this.calculateAnnualGrowthRate(mrrHistory.history);

    // 4. Calcular Net Revenue Retention (NRR)
    const nrr = this.calculateNRR(mrrHistory.history);

    // 5. Calcular Rule of 40
    const ruleOf40Score = growthRate + profit.profitMargin;
    const passedRuleOf40 = ruleOf40Score >= 40;

    // 6. Calcular múltiplo dinámico
    const multipleCalc = this.calculateDynamicMultiple({
      growthRate,
      churnRate: churnData.churnRate,
      nrr,
      profitMargin: profit.profitMargin,
      ruleOf40Score,
      passedRuleOf40,
    });

    // 7. Calcular valoración
    const valuation: ValuationRange = {
      low: Math.round(arrUsd * multipleCalc.low),
      mid: Math.round(arrUsd * multipleCalc.mid),
      high: Math.round(arrUsd * multipleCalc.high),
    };

    const valuationMxn: ValuationRange = {
      low: Math.round(valuation.low * exchangeRate),
      mid: Math.round(valuation.mid * exchangeRate),
      high: Math.round(valuation.high * exchangeRate),
    };

    // 8. Calcular Health Score
    const healthScore = this.calculateHealthScore({
      growthRate,
      churnRate: churnData.churnRate,
      nrr,
      profitMargin: profit.profitMargin,
      ruleOf40Score,
    });

    // 9. Proyección a 12 meses
    const projectedGrowth = Math.max(growthRate, 10); // Mínimo 10% growth
    const arr12Months = arrUsd * (1 + projectedGrowth / 100);
    const projection = {
      arr12Months: Math.round(arr12Months),
      arr12MonthsMxn: Math.round(arr12Months * exchangeRate),
      valuation12Months: {
        low: Math.round(arr12Months * multipleCalc.low),
        mid: Math.round(arr12Months * multipleCalc.mid),
        high: Math.round(arr12Months * multipleCalc.high),
      },
      valuation12MonthsMxn: {
        low: Math.round(arr12Months * multipleCalc.low * exchangeRate),
        mid: Math.round(arr12Months * multipleCalc.mid * exchangeRate),
        high: Math.round(arr12Months * multipleCalc.high * exchangeRate),
      },
      growthAssumption: Math.round(projectedGrowth * 100) / 100,
    };

    // 10. Comparación con mes anterior
    let previousMonth: PreviousMonthComparison | undefined;
    if (previousValuations && previousValuations.length > 0) {
      const prev = previousValuations[0];
      const change =
        prev.valuationMid > 0 ? ((valuation.mid - prev.valuationMid) / prev.valuationMid) * 100 : 0;
      previousMonth = {
        valuation: prev.valuationMid,
        valuationMxn: prev.valuationMidMxn,
        change: Math.round(change * 100) / 100,
        changeDirection: change > 1 ? 'up' : change < -1 ? 'down' : 'stable',
        month: prev.month,
      };
    }

    // 11. Guardar snapshot histórico (solo si es un nuevo mes)
    const currentMonth = this.getCurrentMonth();
    const shouldSaveSnapshot =
      !previousValuations || previousValuations.length === 0 || previousValuations[0].month !== currentMonth;

    if (shouldSaveSnapshot) {
      await this.saveValuationSnapshot({
        month: currentMonth,
        arr: arrUsd,
        arrMxn,
        mrr: mrrUsd,
        mrrMxn,
        valuationLow: valuation.low,
        valuationMid: valuation.mid,
        valuationHigh: valuation.high,
        valuationLowMxn: valuationMxn.low,
        valuationMidMxn: valuationMxn.mid,
        valuationHighMxn: valuationMxn.high,
        multipleLow: multipleCalc.low,
        multipleMid: multipleCalc.mid,
        multipleHigh: multipleCalc.high,
        growthRate,
        churnRate: churnData.churnRate,
        nrr,
        profitMargin: profit.profitMargin,
        ruleOf40Score,
        healthScore,
        exchangeRate,
        calculatedAt: new Date(),
      });
    }

    return {
      valuation,
      valuationMxn,
      multiple: multipleCalc,
      arr: Math.round(arrUsd * 100) / 100,
      arrMxn: Math.round(arrMxn * 100) / 100,
      mrr: Math.round(mrrUsd * 100) / 100,
      mrrMxn: Math.round(mrrMxn * 100) / 100,
      factors: this.buildFactorsDetail({
        growthRate,
        churnRate: churnData.churnRate,
        nrr,
        profitMargin: profit.profitMargin,
        ruleOf40Score,
        passedRuleOf40,
      }),
      healthScore,
      healthLevel: this.getHealthLevel(healthScore),
      projection,
      previousMonth,
      calculatedAt: new Date(),
      methodology: 'Revenue Multiple (ARR x Dynamic Multiple)',
      exchangeRate,
    };
  }

  /**
   * Calcula el múltiplo dinámico basado en benchmarks SaaS
   */
  private calculateDynamicMultiple(metrics: {
    growthRate: number;
    churnRate: number;
    nrr: number;
    profitMargin: number;
    ruleOf40Score: number;
    passedRuleOf40: boolean;
  }): ValuationRange {
    // Múltiplo base para SaaS pequeño: 3x-4x
    let baseMultiple = 3.5;

    // Bonus por Growth Rate (>20% anual = +1x por cada 10%)
    if (metrics.growthRate > 20) {
      const bonusMultiplier = Math.floor((metrics.growthRate - 20) / 10);
      baseMultiple += bonusMultiplier * 1;
    }

    // Bonus por Churn Rate bajo (<3% mensual = +1x)
    if (metrics.churnRate < 3) {
      baseMultiple += 1;
    } else if (metrics.churnRate < 5) {
      baseMultiple += 0.5;
    }

    // Bonus por NRR alto (>110% = +1x)
    if (metrics.nrr > 110) {
      baseMultiple += 1;
    } else if (metrics.nrr > 100) {
      baseMultiple += 0.5;
    }

    // Bonus por Profit Margin (>20% = +1x)
    if (metrics.profitMargin > 20) {
      baseMultiple += 1;
    } else if (metrics.profitMargin > 0) {
      baseMultiple += 0.5;
    }

    // Bonus por Rule of 40 (+2x si cumple)
    if (metrics.passedRuleOf40) {
      baseMultiple += 2;
    }

    // Límites: mínimo 2x, máximo 15x
    baseMultiple = Math.max(2, Math.min(15, baseMultiple));

    return {
      low: Math.round(baseMultiple * 0.7 * 10) / 10, // -30%
      mid: Math.round(baseMultiple * 10) / 10,
      high: Math.round(baseMultiple * 1.4 * 10) / 10, // +40%
    };
  }

  /**
   * Calcula la tasa de crecimiento anual basada en historial de MRR
   */
  private calculateAnnualGrowthRate(history: Array<{ month: string; mrr: number }>): number {
    if (history.length < 2) return 0;

    // Comparar MRR actual vs hace 12 meses (o el más antiguo disponible)
    const currentMrr = history[history.length - 1]?.mrr || 0;
    const oldestMrr = history[0]?.mrr || 0;

    if (oldestMrr === 0) return currentMrr > 0 ? 100 : 0;

    const monthsSpan = history.length - 1;
    if (monthsSpan === 0) return 0;

    const monthlyGrowth = Math.pow(currentMrr / oldestMrr, 1 / monthsSpan) - 1;
    const annualGrowth = (Math.pow(1 + monthlyGrowth, 12) - 1) * 100;

    return Math.round(annualGrowth * 100) / 100;
  }

  /**
   * Calcula Net Revenue Retention (NRR)
   * NRR = (MRR inicio + expansion - contraccion - churn) / MRR inicio * 100
   */
  private calculateNRR(history: Array<{ month: string; mrr: number }>): number {
    if (history.length < 2) return 100;

    const startMrr = history[0]?.mrr || 0;
    const endMrr = history[history.length - 1]?.mrr || 0;

    if (startMrr === 0) return 100;

    // NRR simplificado basado en crecimiento de MRR existente
    const nrr = (endMrr / startMrr) * 100;

    return Math.round(nrr * 100) / 100;
  }

  /**
   * Calcula Health Score del negocio (0-100)
   */
  private calculateHealthScore(metrics: {
    growthRate: number;
    churnRate: number;
    nrr: number;
    profitMargin: number;
    ruleOf40Score: number;
  }): number {
    let score = 50; // Base score

    // Growth Rate (max +20 puntos)
    if (metrics.growthRate >= 50) score += 20;
    else if (metrics.growthRate >= 30) score += 15;
    else if (metrics.growthRate >= 20) score += 10;
    else if (metrics.growthRate >= 10) score += 5;
    else if (metrics.growthRate < 0) score -= 10;

    // Churn Rate (max +20 puntos)
    if (metrics.churnRate <= 2) score += 20;
    else if (metrics.churnRate <= 3) score += 15;
    else if (metrics.churnRate <= 5) score += 10;
    else if (metrics.churnRate <= 7) score += 5;
    else score -= 10;

    // NRR (max +15 puntos)
    if (metrics.nrr >= 120) score += 15;
    else if (metrics.nrr >= 110) score += 12;
    else if (metrics.nrr >= 100) score += 8;
    else score -= 5;

    // Profit Margin (max +15 puntos)
    if (metrics.profitMargin >= 30) score += 15;
    else if (metrics.profitMargin >= 20) score += 12;
    else if (metrics.profitMargin >= 10) score += 8;
    else if (metrics.profitMargin >= 0) score += 4;
    else score -= 10;

    // Rule of 40 (max +10 puntos)
    if (metrics.ruleOf40Score >= 50) score += 10;
    else if (metrics.ruleOf40Score >= 40) score += 8;
    else if (metrics.ruleOf40Score >= 30) score += 4;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private getHealthLevel(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'fair';
    return 'poor';
  }

  private buildFactorsDetail(metrics: {
    growthRate: number;
    churnRate: number;
    nrr: number;
    profitMargin: number;
    ruleOf40Score: number;
    passedRuleOf40: boolean;
  }): ValuationFactors {
    return {
      growthRate: {
        value: Math.round(metrics.growthRate * 100) / 100,
        impact: metrics.growthRate > 20 ? 'positive' : metrics.growthRate > 0 ? 'neutral' : 'negative',
        weight: 3,
        contribution: metrics.growthRate > 20 ? Math.floor((metrics.growthRate - 20) / 10) : 0,
        explanation:
          metrics.growthRate > 20
            ? `Crecimiento ${metrics.growthRate.toFixed(1)}% anual agrega +${Math.floor((metrics.growthRate - 20) / 10)}x al multiplo`
            : `Crecimiento ${metrics.growthRate.toFixed(1)}% anual (objetivo: >20%)`,
      },
      churnRate: {
        value: Math.round(metrics.churnRate * 100) / 100,
        impact: metrics.churnRate < 3 ? 'positive' : metrics.churnRate < 5 ? 'neutral' : 'negative',
        weight: 2,
        contribution: metrics.churnRate < 3 ? 1 : metrics.churnRate < 5 ? 0.5 : 0,
        explanation:
          metrics.churnRate < 3
            ? `Churn ${metrics.churnRate.toFixed(2)}% excelente, agrega +1x`
            : `Churn ${metrics.churnRate.toFixed(2)}% (objetivo: <3%)`,
      },
      nrr: {
        value: Math.round(metrics.nrr * 100) / 100,
        impact: metrics.nrr > 110 ? 'positive' : metrics.nrr > 100 ? 'neutral' : 'negative',
        weight: 2,
        contribution: metrics.nrr > 110 ? 1 : metrics.nrr > 100 ? 0.5 : 0,
        explanation:
          metrics.nrr > 110
            ? `NRR ${metrics.nrr.toFixed(1)}% indica expansion neta, agrega +1x`
            : `NRR ${metrics.nrr.toFixed(1)}% (objetivo: >110%)`,
      },
      profitMargin: {
        value: Math.round(metrics.profitMargin * 100) / 100,
        impact: metrics.profitMargin > 20 ? 'positive' : metrics.profitMargin > 0 ? 'neutral' : 'negative',
        weight: 2,
        contribution: metrics.profitMargin > 20 ? 1 : metrics.profitMargin > 0 ? 0.5 : 0,
        explanation:
          metrics.profitMargin > 20
            ? `Margen ${metrics.profitMargin.toFixed(1)}% saludable, agrega +1x`
            : `Margen ${metrics.profitMargin.toFixed(1)}% (objetivo: >20%)`,
      },
      ruleOf40: {
        value: Math.round(metrics.ruleOf40Score * 100) / 100,
        impact: metrics.passedRuleOf40 ? 'positive' : 'neutral',
        weight: 4,
        contribution: metrics.passedRuleOf40 ? 2 : 0,
        explanation: metrics.passedRuleOf40
          ? `Rule of 40: ${metrics.ruleOf40Score.toFixed(1)} >= 40, premium SaaS (+2x)`
          : `Rule of 40: ${metrics.ruleOf40Score.toFixed(1)} < 40 (Growth + Margin)`,
      },
    };
  }

  private getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  private async saveValuationSnapshot(snapshot: ValuationSnapshot): Promise<void> {
    try {
      await this.firestoreService.saveValuationSnapshot(snapshot);
      this.logger.log(`Saved valuation snapshot for month: ${snapshot.month}`);
    } catch (error) {
      this.logger.error(`Error saving valuation snapshot: ${error.message}`);
    }
  }
}
