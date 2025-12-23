/**
 * Generador de IDs únicos para errores
 * Formato: ERR-YYYYMMDD-XXXXX
 * Ejemplo: ERR-20251222-00042
 */
export class ErrorIdGenerator {
  /**
   * Genera un ID único de error con formato ERR-YYYYMMDD-XXXXX
   * @returns string ID único de error
   */
  static generate(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.floor(Math.random() * 100000)
      .toString()
      .padStart(5, '0');
    return `ERR-${dateStr}-${random}`;
  }

  /**
   * Extrae la fecha de un ID de error
   * @param errorId ID de error con formato ERR-YYYYMMDD-XXXXX
   * @returns Date o null si el formato es inválido
   */
  static parseDate(errorId: string): Date | null {
    const match = errorId.match(/^ERR-(\d{8})-\d{5}$/);
    if (!match) return null;

    const dateStr = match[1];
    const year = parseInt(dateStr.slice(0, 4));
    const month = parseInt(dateStr.slice(4, 6)) - 1;
    const day = parseInt(dateStr.slice(6, 8));

    return new Date(year, month, day);
  }

  /**
   * Valida si un string tiene formato válido de error ID
   * @param errorId String a validar
   * @returns boolean
   */
  static isValid(errorId: string): boolean {
    return /^ERR-\d{8}-\d{5}$/.test(errorId);
  }
}
