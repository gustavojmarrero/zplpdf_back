import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { BillingService } from '../../modules/billing/billing.service.js';

export interface PeriodInfo {
  periodStart: Date;
  periodEnd: Date;
  periodId: string;
}

export interface UserForPeriod {
  id: string;
  plan: 'free' | 'pro' | 'promax' | 'enterprise';
  createdAt: Date;
  stripeSubscriptionId?: string;
}

@Injectable()
export class PeriodCalculatorService {
  constructor(
    @Inject(forwardRef(() => BillingService))
    private readonly billingService: BillingService,
  ) {}

  /**
   * Calcula el período actual para un usuario basado en su plan
   * - Free: período mensual desde fecha de registro (createdAt)
   * - Pro/Enterprise: sincronizado con current_period_end de Stripe
   */
  async calculateCurrentPeriod(user: UserForPeriod): Promise<PeriodInfo> {
    if (user.plan === 'free') {
      return this.calculateFreePeriod(user.id, user.createdAt);
    }

    // Pro/Enterprise: usar Stripe si tiene suscripción
    if (user.stripeSubscriptionId) {
      return this.calculateStripePeriod(user);
    }

    // Fallback para usuarios sin suscripción activa
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
   * Pro/Enterprise con Stripe: usar fechas de la suscripción
   */
  private async calculateStripePeriod(user: UserForPeriod): Promise<PeriodInfo> {
    try {
      const subscription = await this.billingService.getSubscription(user.id);

      if (!subscription || !subscription.currentPeriodEnd) {
        // Fallback a lógica free si no hay suscripción válida
        return this.calculateFreePeriod(user.id, user.createdAt);
      }

      const periodStart = new Date(subscription.currentPeriodStart * 1000);
      const periodEnd = new Date(subscription.currentPeriodEnd * 1000);

      return {
        periodStart,
        periodEnd,
        periodId: this.generatePeriodId(user.id, periodStart),
      };
    } catch {
      // En caso de error con Stripe, usar fallback
      return this.calculateFreePeriod(user.id, user.createdAt);
    }
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
