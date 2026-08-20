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
    const storage = buildStorage(5);

    // Lo que hace un cliente que rota el X-Forwarded-For en cada peticion.
    for (let i = 0; i < 200; i++) {
      await storage.increment(`inventada-${i}`, TTL, 5, 0, 'test');
    }

    expect(storage.storage.size).toBeLessThanOrEqual(5);
    storage.onApplicationShutdown();
  });

  it('expulsa las identidades inventadas antes que el contador que está frenando el abuso', async () => {
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
