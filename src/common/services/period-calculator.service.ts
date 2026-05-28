import { Injectable } from '@nestjs/common';
import {
  calculateCurrentPeriod as calcCurrentPeriod,
  PeriodInfo,
  UserForPeriod,
} from './period-calculator.util.js';

export type { PeriodInfo, UserForPeriod };

@Injectable()
export class PeriodCalculatorService {
  /**
   * Calcula el período actual para un usuario basado en su plan
   * - Free: período mensual desde fecha de registro (createdAt)
   * - Pro/Enterprise: usa fechas guardadas en Firestore (sincronizadas desde Stripe)
   */
  calculateCurrentPeriod(user: UserForPeriod): PeriodInfo {
    return calcCurrentPeriod(user);
  }
}
