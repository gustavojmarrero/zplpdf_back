/**
 * Convierte un valor de fecha (Date, string, number o Firestore Timestamp) a ISO string
 * @param value Valor a convertir
 * @returns ISO string de la fecha
 */
export function toISOString(value: Date | string | number | { toDate?: () => Date }): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }
  if (typeof value === 'object' && value !== null && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return new Date(value as string | number).toISOString();
}

/**
 * Asegura que un valor sea ISO string - si ya es string, lo retorna; si es Date, lo convierte
 * @param value Valor a procesar
 * @returns ISO string de la fecha
 */
export function ensureISOString(value: Date | string | { toDate?: () => Date }): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object' && value !== null && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return String(value);
}
