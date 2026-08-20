import { Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageOptions } from '@nestjs/throttler/dist/throttler-storage-options.interface.js';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';

type TimeoutId = ReturnType<typeof setTimeout>;

/**
 * Claves vivas como maximo. Cada una es una entrada pequeña de un Map, asi que
 * el tope existe para acotar el peor caso, no para ajustar el uso normal: una
 * ruta publica con trafico honesto no pasa de unos cientos.
 */
export const BOUNDED_THROTTLER_MAX_KEYS = 10000;

/**
 * `ThrottlerStorageService` expira los contadores pero NUNCA borra keys de su
 * Map (limitacion ya documentada en `CustomThrottlerGuard`). Ademas agrupa los
 * timers solo por nombre de throttler, por lo que no permite cancelar de forma
 * selectiva los de una clave expulsada. En una ruta publica donde parte de la
 * identidad la elige el cliente —la IP que declara en `X-Forwarded-For`— ambas
 * cosas permiten que un ataque sin login siga reteniendo memoria.
 *
 * Este storage conserva el contrato y la semantica de ventanas del original,
 * pero gestiona cada timer junto a su clave. Tambien añade expulsion LRU: cada
 * acceso reinserta la clave al final del Map, asi que lo que se descarta al
 * pasarse del tope son las identidades inventadas que nadie vuelve a usar, no
 * los contadores activos que estan conteniendo un abuso.
 */
@Injectable()
export class BoundedThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  private readonly entries = new Map<string, ThrottlerStorageOptions>();
  private readonly timeoutIds = new Map<string, Map<string, Set<TimeoutId>>>();

  /**
   * Propiedad y no parametro de constructor: Nest instancia este storage como
   * provider y trataria un `maxKeys: number` como una dependencia mas que
   * inyectar. Los tests la bajan despues de construir.
   */
  maxKeys: number = BOUNDED_THROTTLER_MAX_KEYS;

  get storage() {
    return this.entries;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.entries.has(key)) {
      this.entries.set(key, {
        totalHits: new Map([[throttlerName, 0]]),
        expiresAt: Date.now() + ttl,
        blockExpiresAt: 0,
        isBlocked: false,
      });
    }

    const entry = this.entries.get(key)!;
    if (!entry.totalHits.has(throttlerName)) {
      entry.totalHits.set(throttlerName, 0);
    }

    let timeToExpire = this.getExpirationTime(entry);
    if (timeToExpire <= 0) {
      entry.expiresAt = Date.now() + ttl;
      timeToExpire = this.getExpirationTime(entry);
    }

    if (!entry.isBlocked) {
      this.fireHitCount(key, entry, throttlerName, ttl);
    }

    if ((entry.totalHits.get(throttlerName) ?? 0) > limit && !entry.isBlocked) {
      entry.isBlocked = true;
      entry.blockExpiresAt = Date.now() + blockDuration;
    }

    let timeToBlockExpire = this.getBlockExpirationTime(entry);
    if (timeToBlockExpire <= 0 && entry.isBlocked) {
      this.resetBlockedRequest(key, entry, throttlerName);
      this.fireHitCount(key, entry, throttlerName, ttl);
      timeToBlockExpire = this.getBlockExpirationTime(entry);
    }

    this.touch(key);
    this.evictOldest();

    return {
      totalHits: entry.totalHits.get(throttlerName) ?? 0,
      timeToExpire,
      isBlocked: entry.isBlocked,
      timeToBlockExpire,
    };
  }

  /** Reinsertar mueve la clave al final del orden de iteracion del Map. */
  private touch(key: string): void {
    const value = this.entries.get(key);
    if (value === undefined) return;
    this.entries.delete(key);
    this.entries.set(key, value);
  }

  private evictOldest(): void {
    if (this.entries.size <= this.maxKeys) return;

    for (const oldest of this.entries.keys()) {
      this.deleteEntry(oldest);
      if (this.entries.size <= this.maxKeys) break;
    }
  }

  onApplicationShutdown(): void {
    for (const key of this.timeoutIds.keys()) {
      this.clearExpirationTimes(key);
    }
    this.entries.clear();
  }

  private getExpirationTime(entry: ThrottlerStorageOptions): number {
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  private getBlockExpirationTime(entry: ThrottlerStorageOptions): number {
    return Math.ceil((entry.blockExpiresAt - Date.now()) / 1000);
  }

  private fireHitCount(
    key: string,
    entry: ThrottlerStorageOptions,
    throttlerName: string,
    ttl: number,
  ): void {
    entry.totalHits.set(
      throttlerName,
      (entry.totalHits.get(throttlerName) ?? 0) + 1,
    );

    const timeoutId = setTimeout(() => {
      this.removeTimeoutId(key, throttlerName, timeoutId);

      const current = this.entries.get(key);
      if (current === undefined) return;

      const remainingHits = Math.max(
        0,
        (current.totalHits.get(throttlerName) ?? 0) - 1,
      );
      current.totalHits.set(throttlerName, remainingHits);

      if (
        !current.isBlocked &&
        [...current.totalHits.values()].every((hits) => hits === 0)
      ) {
        this.deleteEntry(key);
      }
    }, ttl);

    this.getTimeoutIds(key, throttlerName).add(timeoutId);
  }

  private resetBlockedRequest(
    key: string,
    entry: ThrottlerStorageOptions,
    throttlerName: string,
  ): void {
    entry.isBlocked = false;
    entry.totalHits.set(throttlerName, 0);
    this.clearExpirationTimes(key, throttlerName);
  }

  private getTimeoutIds(key: string, throttlerName: string): Set<TimeoutId> {
    let byThrottler = this.timeoutIds.get(key);
    if (byThrottler === undefined) {
      byThrottler = new Map();
      this.timeoutIds.set(key, byThrottler);
    }

    let ids = byThrottler.get(throttlerName);
    if (ids === undefined) {
      ids = new Set();
      byThrottler.set(throttlerName, ids);
    }

    return ids;
  }

  private removeTimeoutId(
    key: string,
    throttlerName: string,
    timeoutId: TimeoutId,
  ): void {
    const byThrottler = this.timeoutIds.get(key);
    const ids = byThrottler?.get(throttlerName);
    if (ids === undefined) return;

    ids.delete(timeoutId);
    if (ids.size === 0) byThrottler!.delete(throttlerName);
    if (byThrottler!.size === 0) this.timeoutIds.delete(key);
  }

  private clearExpirationTimes(key: string, throttlerName?: string): void {
    const byThrottler = this.timeoutIds.get(key);
    if (byThrottler === undefined) return;

    if (throttlerName !== undefined) {
      byThrottler.get(throttlerName)?.forEach(clearTimeout);
      byThrottler.delete(throttlerName);
      if (byThrottler.size === 0) this.timeoutIds.delete(key);
      return;
    }

    for (const ids of byThrottler.values()) {
      ids.forEach(clearTimeout);
    }
    this.timeoutIds.delete(key);
  }

  private deleteEntry(key: string): void {
    this.clearExpirationTimes(key);
    this.entries.delete(key);
  }
}
