import { Injectable } from '@nestjs/common';

export interface PeriodInfo {
  periodStart: Date;
  periodEnd: Date;
  periodId: string;
}

export interface UserForPeriod {
  id: string;
  plan: 'free' | 'pro' | 'promax' | 'enterprise';
  createdAt: Date;
  // Fechas del período de suscripción (sincronizadas desde Stripe webhooks)
  subscriptionPeriodStart?: Date;
  subscriptionPeriodEnd?: Date;
}

@Injectable()
export class PeriodCalculatorService {
  /**
   * Calcula el período actual para un usuario basado en su plan
   * - Free: período mensual desde fecha de registro (createdAt)
   * - Pro/Enterprise: usa fechas guardadas en Firestore (sincronizadas desde Stripe)
   */
  calculateCurrentPeriod(user: UserForPeriod): PeriodInfo {
    if (user.plan === 'free') {
      return this.calculateFreePeriod(user.id, user.createdAt);
    }

    // Pro/Enterprise: usar fechas guardadas en Firestore
    if (user.subscriptionPeriodStart && user.subscriptionPeriodEnd) {
      const periodStart = user.subscriptionPeriodStart instanceof Date
        ? user.subscriptionPeriodStart
        : new Date(user.subscriptionPeriodStart);
      const periodEnd = user.subscriptionPeriodEnd instanceof Date
        ? user.subscriptionPeriodEnd
        : new Date(user.subscriptionPeriodEnd);

      return {
        periodStart,
        periodEnd,
        periodId: this.generatePeriodId(user.id, periodStart),
      };
    }

    // Fallback para usuarios Pro sin fechas de período (pendiente migración)
    return this.calculateFreePeriod(user.id, user.createdAt);
  }

  /**
   * Plan Free: período mensual desde fecha de registro
   * Ejemplo: Usuario registrado el 15 de enero
   * - Período 1: 15 enero → 15 febrero
   * - Período 2: 15 febrero → 15 marzo
   */
  private calculateFreePeriod(userId: string, createdAt: Date): PeriodInfo {
    const now = new Date();
    const registrationDay = createdAt.getDate();

    // Encontrar el periodStart más reciente
    let periodStart = new Date(now.getFullYear(), now.getMonth(), registrationDay);

    // Si el día de registro aún no ha llegado este mes, el período empezó el mes pasado
    if (periodStart > now) {
      periodStart.setMonth(periodStart.getMonth() - 1);
    }

    // periodEnd = periodStart + 1 mes - 1 milisegundo
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    periodEnd.setMilliseconds(periodEnd.getMilliseconds() - 1);

    return {
      periodStart,
      periodEnd,
      periodId: this.generatePeriodId(userId, periodStart),
    };
  }

  /**
   * Genera ID único para el período
   * Formato: userId_YYYYMMDD (fecha de inicio del período)
   */
  private generatePeriodId(userId: string, periodStart: Date): string {
    const year = periodStart.getFullYear();
    const month = String(periodStart.getMonth() + 1).padStart(2, '0');
    const day = String(periodStart.getDate()).padStart(2, '0');
    return `${userId}_${year}${month}${day}`;
  }
}
