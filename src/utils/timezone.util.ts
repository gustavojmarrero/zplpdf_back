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
