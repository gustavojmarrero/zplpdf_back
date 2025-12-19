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
