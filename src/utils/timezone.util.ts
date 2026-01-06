/**
 * Utilidades de zona horaria para métricas del dashboard
 * Zona horaria: GMT-6 (Mérida, México)
 */

const GMT_OFFSET_HOURS = 6; // GMT-6 = 6 horas detrás de UTC

/**
 * Obtiene el inicio del día actual en GMT-6
 * Ejemplo: Si son las 01:46 UTC del 19 dic, en GMT-6 son las 19:46 del 18 dic
 *          El inicio del día sería 06:00 UTC del 18 dic (= 00:00 GMT-6 del 18 dic)
 */
export function getStartOfDayInTimezone(date: Date = new Date()): Date {
  const utcHours = date.getUTCHours();

  // Determinar qué día es en GMT-6
  // Si UTC es 00:00-05:59, en GMT-6 todavía es el día anterior
  let targetDate: Date;
  if (utcHours < GMT_OFFSET_HOURS) {
    // En GMT-6 todavía es el día anterior
    targetDate = new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() - 1,
      ),
    );
  } else {
    targetDate = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  // Inicio del día en GMT-6 = 06:00 UTC de ese día
  return new Date(
    Date.UTC(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth(),
      targetDate.getUTCDate(),
      GMT_OFFSET_HOURS,
      0,
      0,
      0,
    ),
  );
}

/**
 * Convierte una fecha UTC a string de fecha en GMT-6 (YYYY-MM-DD)
 * Ejemplo: 2025-12-19T01:00:00Z (UTC) → "2025-12-18" (GMT-6)
 */
export function getDateStringInTimezone(date: Date = new Date()): string {
  const utcHours = date.getUTCHours();

  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  let day = date.getUTCDate();

  // Si UTC es 00:00-05:59, en GMT-6 todavía es el día anterior
  if (utcHours < GMT_OFFSET_HOURS) {
    const prevDay = new Date(Date.UTC(year, month, day - 1));
    year = prevDay.getUTCFullYear();
    month = prevDay.getUTCMonth();
    day = prevDay.getUTCDate();
  }

  const monthStr = String(month + 1).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');

  return `${year}-${monthStr}-${dayStr}`;
}

/**
 * Obtiene el mes actual en GMT-6 (YYYY-MM)
 * Ejemplo: Si son las 03:00 UTC del 1 de febrero, en GMT-6 todavía es enero
 */
export function getCurrentMonthInTimezone(date: Date = new Date()): string {
  const utcHours = date.getUTCHours();

  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  let day = date.getUTCDate();

  // Si UTC es 00:00-05:59, en GMT-6 todavía es el día anterior
  if (utcHours < GMT_OFFSET_HOURS) {
    const prevDay = new Date(Date.UTC(year, month, day - 1));
    year = prevDay.getUTCFullYear();
    month = prevDay.getUTCMonth();
  }

  const monthStr = String(month + 1).padStart(2, '0');
  return `${year}-${monthStr}`;
}

/**
 * Obtiene las fechas de inicio y fin de un mes en GMT-6
 * startDate: 00:00:00 GMT-6 del primer día (= 06:00:00 UTC)
 * endDate: 23:59:59 GMT-6 del último día (= 05:59:59 UTC del día siguiente)
 */
export function getMonthDatesInTimezone(month: string): { startDate: Date; endDate: Date } {
  const [year, monthNum] = month.split('-').map(Number);

  // Inicio del mes: 00:00:00 GMT-6 = 06:00:00 UTC del día 1
  const startDate = new Date(Date.UTC(year, monthNum - 1, 1, GMT_OFFSET_HOURS, 0, 0));

  // Fin del mes: 23:59:59 GMT-6 del último día
  // = 05:59:59 UTC del día 1 del mes siguiente
  const lastDay = new Date(year, monthNum, 0).getDate(); // Último día del mes
  const endDate = new Date(Date.UTC(year, monthNum - 1, lastDay, GMT_OFFSET_HOURS + 23, 59, 59));

  return { startDate, endDate };
}

/**
 * Obtiene el día actual del mes en GMT-6
 */
export function getCurrentDayInTimezone(date: Date = new Date()): number {
  const utcHours = date.getUTCHours();

  let day = date.getUTCDate();

  // Si UTC es 00:00-05:59, en GMT-6 todavía es el día anterior
  if (utcHours < GMT_OFFSET_HOURS) {
    const prevDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), day - 1));
    day = prevDay.getUTCDate();
  }

  return day;
}
