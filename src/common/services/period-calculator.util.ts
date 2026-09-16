export interface PeriodInfo {
  periodStart: Date;
  periodEnd: Date;
  periodId: string;
}

export interface UserForPeriod {
  id: string;
  plan: 'free' | 'lite' | 'pro' | 'promax' | 'enterprise';
  createdAt: Date;
  subscriptionPeriodStart?: Date;
  subscriptionPeriodEnd?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Duración máxima de un periodo de Stripe que se usa tal cual como periodo de
 * cuota. Un mes de calendario dura entre 28 y 31 días; el margen hasta 35 deja
 * fuera cualquier desajuste de horas sin llegar nunca a un periodo bimestral o
 * anual. Por encima de este umbral la cuota se reparte en subperiodos mensuales.
 */
export const MAX_MONTHLY_BILLING_PERIOD_MS = 35 * DAY_MS;

/**
 * Un resto final más corto que esto no forma subperiodo propio: se suma al
 * anterior. Así un periodo de Stripe que no cuadra exacto con los meses
 * anclados (p. ej. una renovación anual 28 feb → 29 feb con ancla original el
 * 29) no regala una cuota mensual entera por uno o dos días. Es coherente con
 * el umbral de arriba: 28 días (el mes más corto) + 7 = 35.
 */
export const MIN_TRAILING_SUBPERIOD_MS = 7 * DAY_MS;

export function generatePeriodId(userId: string, periodStart: Date): string {
  const year = periodStart.getFullYear();
  const month = String(periodStart.getMonth() + 1).padStart(2, '0');
  const day = String(periodStart.getDate()).padStart(2, '0');
  return `${userId}_${year}${month}${day}`;
}

export function calculateFreePeriod(
  userId: string,
  createdAt: Date,
  now: Date = new Date(),
): PeriodInfo {
  const registrationDay = createdAt.getDate();

  const periodStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    registrationDay,
  );
  if (periodStart > now) {
    periodStart.setMonth(periodStart.getMonth() - 1);
  }

  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  periodEnd.setMilliseconds(periodEnd.getMilliseconds() - 1);

  return {
    periodStart,
    periodEnd,
    periodId: generatePeriodId(userId, periodStart),
  };
}

/**
 * Suma `months` meses a `anchor` en UTC conservando el día del mes y la hora.
 *
 * Regla de anclaje: día = min(díaAncla, díasDelMesDestino). Una suscripción que
 * empezó el 31 cae el 28/29 de febrero, el 30 de abril, etc., y vuelve al 31 en
 * cuanto el mes lo permite. Se calcula SIEMPRE desde el ancla original y nunca
 * encadenando desde el subperiodo anterior: encadenar arrastraría el 28 de
 * febrero a todos los meses siguientes.
 */
function addUtcMonthsAnchored(anchor: Date, months: number): Date {
  const targetMonthIndex = anchor.getUTCMonth() + months;
  // Día 0 del mes siguiente = último día del mes destino (Date.UTC normaliza
  // el desbordamiento de meses hacia años).
  const daysInTargetMonth = new Date(
    Date.UTC(anchor.getUTCFullYear(), targetMonthIndex + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      targetMonthIndex,
      Math.min(anchor.getUTCDate(), daysInTargetMonth),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * Mayor k ≥ 0 tal que addUtcMonthsAnchored(anchor, k) <= instant.
 * Presupone instant >= anchor.
 */
function monthlyIndexAt(anchor: Date, instant: Date): number {
  // La diferencia de meses de calendario nunca se queda corta (el inicio k+1
  // cae ya en el mes siguiente al de `instant`) y como mucho se pasa por uno.
  let k = Math.max(
    0,
    (instant.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (instant.getUTCMonth() - anchor.getUTCMonth()),
  );
  while (k > 0 && addUtcMonthsAnchored(anchor, k) > instant) {
    k--;
  }
  while (addUtcMonthsAnchored(anchor, k + 1) <= instant) {
    k++;
  }
  return k;
}

/**
 * Subperiodo mensual de un periodo de facturación largo (anual) que contiene
 * `now`.
 *
 * - Zona horaria: UTC. Las fechas de Stripe son instantes UTC y Stripe calcula
 *   sus propios anclajes en UTC; así el resultado no depende del TZ del proceso.
 * - Subperiodo k: [ancla + k meses, ancla + (k+1) meses), con la regla de
 *   anclaje de addUtcMonthsAnchored. El fin es EXCLUSIVO e igual al inicio del
 *   siguiente, como `current_period_end` de Stripe: no hay huecos ni solapes, y
 *   un `now` exactamente en el borde pertenece ya al subperiodo nuevo.
 * - El último subperiodo termina en `end` (el fin real de Stripe); un resto
 *   menor que MIN_TRAILING_SUBPERIOD_MS se absorbe en el anterior.
 * - `now` fuera de [start, end) se acota al primer o al último subperiodo. Es lo
 *   mismo que hace hoy el camino mensual, que devuelve el periodo de Stripe
 *   guardado aunque `now` ya lo haya rebasado (webhook de renovación tardío):
 *   no se abre una cuota nueva hasta que Stripe confirma el periodo siguiente.
 */
function calculateMonthlySubperiod(
  start: Date,
  end: Date,
  now: Date,
): { periodStart: Date; periodEnd: Date } {
  let lastIndex = monthlyIndexAt(start, new Date(end.getTime() - 1));
  if (
    lastIndex > 0 &&
    end.getTime() - addUtcMonthsAnchored(start, lastIndex).getTime() <
      MIN_TRAILING_SUBPERIOD_MS
  ) {
    lastIndex--;
  }

  const index =
    now.getTime() < start.getTime()
      ? 0
      : Math.min(monthlyIndexAt(start, now), lastIndex);

  return {
    periodStart: addUtcMonthsAnchored(start, index),
    periodEnd:
      index === lastIndex ? end : addUtcMonthsAnchored(start, index + 1),
  };
}

/**
 * Periodo de cuota vigente del usuario. La cuota es SIEMPRE mensual:
 *
 * - Free (y cualquier plan sin fechas de Stripe): mes anclado a createdAt.
 * - Pago con periodo de Stripe de hasta 35 días (suscripción mensual): el
 *   periodo de Stripe tal cual.
 * - Pago con periodo de Stripe de más de 35 días (suscripción anual): el
 *   subperiodo mensual anclado al día de subscriptionPeriodStart que contiene
 *   `now` (ver calculateMonthlySubperiod). Sin esto, 500 PDFs/mes serían 500
 *   PDFs/año.
 *
 * El periodId sigue siendo `userId_YYYYMMDD` con la fecha de inicio del periodo
 * devuelto, así que el uso de una suscripción anual queda en un documento por
 * mes. generatePeriodId usa los getters locales del proceso (Cloud Run corre en
 * UTC); el primer subperiodo empieza en subscriptionPeriodStart, así que su id
 * coincide con el que habría dado el camino mensual.
 */
export function calculateCurrentPeriod(
  user: UserForPeriod,
  now: Date = new Date(),
): PeriodInfo {
  if (user.plan === 'free') {
    return calculateFreePeriod(user.id, user.createdAt, now);
  }

  if (user.subscriptionPeriodStart && user.subscriptionPeriodEnd) {
    const subscriptionStart =
      user.subscriptionPeriodStart instanceof Date
        ? user.subscriptionPeriodStart
        : new Date(user.subscriptionPeriodStart);
    const subscriptionEnd =
      user.subscriptionPeriodEnd instanceof Date
        ? user.subscriptionPeriodEnd
        : new Date(user.subscriptionPeriodEnd);

    // Comparación falsa con fechas inválidas (NaN): esas siguen el camino de
    // siempre, sin cambios.
    if (
      subscriptionEnd.getTime() - subscriptionStart.getTime() >
      MAX_MONTHLY_BILLING_PERIOD_MS
    ) {
      const { periodStart, periodEnd } = calculateMonthlySubperiod(
        subscriptionStart,
        subscriptionEnd,
        now,
      );
      return {
        periodStart,
        periodEnd,
        periodId: generatePeriodId(user.id, periodStart),
      };
    }

    return {
      periodStart: subscriptionStart,
      periodEnd: subscriptionEnd,
      periodId: generatePeriodId(user.id, subscriptionStart),
    };
  }

  return calculateFreePeriod(user.id, user.createdAt, now);
}
