import {
  BoundedThrottlerStorage,
  BOUNDED_THROTTLER_MAX_KEYS,
} from './bounded-throttler.storage.js';

const TTL = 60000;

const buildStorage = (maxKeys: number) => {
  const storage = new BoundedThrottlerStorage();
  storage.maxKeys = maxKeys;
  return storage;
};

describe('BoundedThrottlerStorage', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('cuenta como el storage de siempre mientras cabe', async () => {
    const storage = buildStorage(10);

    const primera = await storage.increment('a', TTL, 5, 0, 'test');
    const segunda = await storage.increment('a', TTL, 5, 0, 'test');

    expect(primera.totalHits).toBe(1);
    expect(segunda.totalHits).toBe(2);
    storage.onApplicationShutdown();
  });

  it('no crece por encima del tope aunque las identidades sean infinitas', async () => {
    jest.useFakeTimers();
    const storage = buildStorage(5);

    // Lo que hace un cliente que rota el X-Forwarded-For en cada peticion.
    for (let i = 0; i < 200; i++) {
      await storage.increment(`inventada-${i}`, TTL, 5, 0, 'test');
    }

    expect(storage.storage.size).toBeLessThanOrEqual(5);
    expect(jest.getTimerCount()).toBeLessThanOrEqual(5);
    storage.onApplicationShutdown();
  });

  it('cancela los timers de una clave al expulsarla', async () => {
    jest.useFakeTimers();
    const storage = buildStorage(1);

    await storage.increment('expulsada', TTL, 5, 0, 'test');
    await storage.increment('expulsada', TTL, 5, 0, 'test');
    await storage.increment('vigente', TTL, 5, 0, 'test');

    expect(storage.storage.has('expulsada')).toBe(false);
    expect(storage.storage.has('vigente')).toBe(true);
    expect(jest.getTimerCount()).toBe(1);

    // El callback de la clave expulsada ya no puede ejecutarse sobre undefined.
    jest.advanceTimersByTime(TTL);
    expect(storage.storage.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    storage.onApplicationShutdown();
  });

  it('cancela todos los timers pendientes al cerrar la aplicacion', async () => {
    jest.useFakeTimers();
    const storage = buildStorage(10);

    await storage.increment('a', TTL, 5, 0, 'test');
    await storage.increment('b', TTL, 5, 0, 'test');
    expect(jest.getTimerCount()).toBe(2);

    storage.onApplicationShutdown();

    expect(jest.getTimerCount()).toBe(0);
    expect(storage.storage.size).toBe(0);
  });

  it('expulsa las identidades inventadas antes que el contador que está frenando el abuso', async () => {
    jest.useFakeTimers();
    const storage = buildStorage(3);

    // El contador de verdad se toca en cada peticion; los inventados, una vez.
    for (let i = 0; i < 50; i++) {
      await storage.increment('hop:198.51.100.7', TTL, 100, 0, 'peer');
      await storage.increment(`client:203.0.113.${i}`, TTL, 100, 0, 'client');
    }

    expect(storage.storage.has('hop:198.51.100.7')).toBe(true);
    storage.onApplicationShutdown();
  });

  it('el tope por defecto deja sitio de sobra para trafico honesto', () => {
    expect(BOUNDED_THROTTLER_MAX_KEYS).toBeGreaterThanOrEqual(1000);
  });
});
