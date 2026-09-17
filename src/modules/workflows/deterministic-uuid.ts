import { createHash } from 'node:crypto';

/**
 * UUID en formato v4 derivado de una semilla.
 *
 * Hace falta porque dos exigencias chocan: el puente de conversión y el
 * registro de eventos validan `isUUID(x, '4')`, mientras que la idempotencia
 * necesita que el identificador de una operación sea **el mismo** cada vez que
 * se repite la misma petición. Un `randomUUID()` cumple el formato pero no es
 * estable, y un hash es estable pero no pasa la validación.
 *
 * La semilla se reduce a 128 bits con SHA-256 y se le colocan los bits de
 * versión y variante que exige el formato. No es aleatorio —y no pretende
 * serlo—: es un identificador determinista con la forma que el contrato pide.
 * La probabilidad de colisión con 122 bits efectivos es despreciable.
 */
export function deterministicUuidV4(seed: string): string {
  const bytes = createHash('sha256')
    .update(seed, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // versión 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
