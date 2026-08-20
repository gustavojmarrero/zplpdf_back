import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';

/**
 * Claves vivas como maximo. Cada una es una entrada pequeña de un Map, asi que
 * el tope existe para acotar el peor caso, no para ajustar el uso normal: una
 * ruta publica con trafico honesto no pasa de unos cientos.
 */
export const BOUNDED_THROTTLER_MAX_KEYS = 10000;

/**
 * `ThrottlerStorageService` expira los contadores pero NUNCA borra keys de su
 * Map (limitacion ya documentada en `CustomThrottlerGuard`). En una ruta
 * autenticada eso crece despacio; en una publica donde parte de la identidad la
 * elige el cliente —la IP que declara en `X-Forwarded-For`— crece tan rapido
 * como se pidan peticiones, y agotar memoria pasa a ser un ataque sin login.
 *
 * Este storage envuelve al de siempre y le añade expulsion LRU: cada acceso
 * reinserta la clave al final del Map, asi que lo que se descarta al pasarse
 * del tope son siempre las identidades inventadas que nadie vuelve a usar, no
 * los contadores activos que estan conteniendo un abuso.
 */
@Injectable()
export class BoundedThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  private readonly inner = new ThrottlerStorageService();

  /**
   * Propiedad y no parametro de constructor: Nest instancia este storage como
   * provider y trataria un `maxKeys: number` como una dependencia mas que
   * inyectar. Los tests la bajan despues de construir.
   */
  maxKeys: number = BOUNDED_THROTTLER_MAX_KEYS;

  get storage() {
    return this.inner.storage;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const record = await this.inner.increment(
      key,
      ttl,
      limit,
      blockDuration,
      throttlerName,
    );

    this.touch(key);
    this.evictOldest();

    return record;
  }

  /** Reinsertar mueve la clave al final del orden de iteracion del Map. */
  private touch(key: string): void {
    const value = this.inner.storage.get(key);
    if (value === undefined) return;
    this.inner.storage.delete(key);
    this.inner.storage.set(key, value);
  }

  private evictOldest(): void {
    const map = this.inner.storage;
    if (map.size <= this.maxKeys) return;

    for (const oldest of map.keys()) {
      map.delete(oldest);
      if (map.size <= this.maxKeys) break;
    }
  }

  onApplicationShutdown(): void {
    this.inner.onApplicationShutdown();
  }
}
