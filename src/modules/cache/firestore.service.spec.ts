import { FirestoreService } from './firestore.service.js';

/**
 * Stripe no garantiza el orden de entrega de los webhooks, y releer la
 * suscripción antes de escribir no basta: entre esa lectura y la escritura cabe
 * otra escritura más fresca. La guarda de versión decide por frescura del dato
 * leído, no por orden de llegada (issue #74).
 */
describe('FirestoreService — updateUserSubscriptionState', () => {
  /**
   * Reproduce la semántica de `runTransaction`: la lectura ve el documento tal
   * como está y la escritura se aplica sobre el mismo objeto, para que un
   * descarte se distinga de una escritura efectiva.
   */
  function buildService(docData: Record<string, unknown>) {
    const update = jest
      .fn()
      .mockImplementation((_ref: unknown, data: Record<string, unknown>) => {
        Object.assign(docData, data);
      });

    const ref = { id: 'uid-1' };
    const service: any = Object.create(FirestoreService.prototype);
    service.usersCollection = 'users';
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.firestore = {
      collection: () => ({ doc: () => ref }),
      runTransaction: (fn: (t: unknown) => Promise<boolean>) =>
        fn({
          get: async () => ({ data: () => docData }),
          update,
        }),
    };

    return { service, update, docData };
  }

  it('aplica la escritura cuando no hay ninguna lectura previa registrada', async () => {
    const { service, update, docData } = buildService({ plan: 'free' });
    const readAt = new Date('2026-08-05T10:00:00.000Z');

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'promax' },
      readAt,
    );

    expect(aplicada).toBe(true);
    expect(update).toHaveBeenCalled();
    expect(docData.plan).toBe('promax');
    // El sello queda en el documento para ordenar las escrituras siguientes.
    expect(docData.subscriptionSyncedAt).toBe('2026-08-05T10:00:00.000Z');
  });

  it('descarta la escritura originada en una lectura anterior a la ya aplicada', async () => {
    const { service, update, docData } = buildService({
      plan: 'promax',
      subscriptionSyncedAt: '2026-08-05T10:00:05.000Z',
    });

    // Webhook con el precio viejo, leído 5 s antes y entregado tarde.
    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'pro' },
      new Date('2026-08-05T10:00:00.000Z'),
    );

    expect(aplicada).toBe(false);
    expect(update).not.toHaveBeenCalled();
    // Sin la guarda, el cliente acababa en PRO habiendo pagado PROMAX.
    expect(docData.plan).toBe('promax');
  });

  it('aplica la escritura originada en una lectura posterior', async () => {
    const { service, docData } = buildService({
      plan: 'pro',
      subscriptionSyncedAt: '2026-08-05T10:00:00.000Z',
    });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'promax' },
      new Date('2026-08-05T10:00:05.000Z'),
    );

    expect(aplicada).toBe(true);
    expect(docData.plan).toBe('promax');
  });

  it('acepta la escritura del mismo milisegundo', async () => {
    // Dos lecturas simultáneas describen el mismo estado: descartar la segunda
    // no aportaría nada y podría perder campos que la primera no traía.
    const { service } = buildService({
      subscriptionSyncedAt: '2026-08-05T10:00:00.000Z',
    });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'promax' },
      new Date('2026-08-05T10:00:00.000Z'),
    );

    expect(aplicada).toBe(true);
  });

  it('tolera un sello almacenado como Timestamp de Firestore', async () => {
    // El campo se escribe como ISO string, pero un documento anterior pudo
    // quedar con Timestamp; leerlo mal degradaría la guarda en silencio.
    const { service, update } = buildService({
      subscriptionSyncedAt: {
        toDate: () => new Date('2026-08-05T10:00:05.000Z'),
      },
    });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'pro' },
      new Date('2026-08-05T10:00:00.000Z'),
    );

    expect(aplicada).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('aplica la escritura si el sello almacenado es ilegible', async () => {
    // Un valor corrupto no debe bloquear las sincronizaciones para siempre.
    const { service } = buildService({ subscriptionSyncedAt: 'no-es-fecha' });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'promax' },
      new Date('2026-08-05T10:00:00.000Z'),
    );

    expect(aplicada).toBe(true);
  });
});

/**
 * La clave protege del doble cargo del MISMO upgrade, pero dos upgrades a
 * destinos DISTINTOS no pueden compartirla: si el segundo sobrescribe al
 * primero, Stripe procesa ambas mutaciones (issue #73).
 */
describe('FirestoreService — acquireUpgradeIdempotency', () => {
  const TTL_MS = 24 * 60 * 60 * 1000;
  const LEASE_MS = 7 * 60 * 1000;

  function buildService(stored?: Record<string, unknown>) {
    const docData: Record<string, unknown> = stored
      ? { upgradeIdempotency: stored }
      : {};
    const update = jest
      .fn()
      .mockImplementation((_ref: unknown, data: Record<string, unknown>) => {
        Object.assign(docData, data);
      });

    const ref = { id: 'uid-1' };
    const service: any = Object.create(FirestoreService.prototype);
    service.usersCollection = 'users';
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.firestore = {
      collection: () => ({ doc: () => ref }),
      runTransaction: (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          get: async () => ({ data: () => docData }),
          update,
        }),
    };

    return { service, update, docData };
  }

  function candidato(targetPlan: string, subscriptionId = 'sub_123') {
    return { key: `upgrade_nuevo_${targetPlan}`, targetPlan, subscriptionId };
  }

  function hace(ms: number) {
    return new Date(Date.now() - ms).toISOString();
  }

  it('reutiliza la clave del mismo destino dentro del TTL', async () => {
    // El caso original: el reintento del mismo upgrade no debe cobrar dos veces.
    // El instante se captura UNA vez: dos llamadas a `hace()` difieren en algún
    // milisegundo y la comparación quedaría a merced del reloj.
    const haceUnaHora = hace(60 * 60 * 1000);
    const { service, docData } = buildService({
      key: 'upgrade_previo',
      targetPlan: 'promax',
      subscriptionId: 'sub_123',
      createdAt: haceUnaHora,
      lastAttemptAt: haceUnaHora,
    });

    const result = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );

    expect(result).toEqual({ status: 'ok', key: 'upgrade_previo' });
    // La edad de la clave no se toca —de ella depende el TTL—, pero el lease sí
    // se renueva: es una ejecución nueva.
    expect((docData.upgradeIdempotency as any).createdAt).toBe(haceUnaHora);
    expect(
      new Date((docData.upgradeIdempotency as any).lastAttemptAt).getTime(),
    ).toBeGreaterThan(new Date(haceUnaHora).getTime());
  });

  /**
   * El escenario que el lease existe para cubrir: un reintento reutiliza la
   * clave, pero con la antigüedad congelada en `createdAt` su ejecución quedaba
   * desprotegida en cuanto la clave envejecía más que la ventana, y otro destino
   * entraba con clave propia mientras el reintento seguía vivo.
   */
  it('renueva el lease al reutilizar, de modo que el reintento sigue excluyendo a otros destinos', async () => {
    const haceMediaHora = hace(30 * 60 * 1000);
    const { service, docData } = buildService({
      key: 'upgrade_previo',
      targetPlan: 'promax',
      subscriptionId: 'sub_123',
      // Clave nacida hace media hora: el lease original expiró hace mucho.
      createdAt: haceMediaHora,
      lastAttemptAt: haceMediaHora,
    });

    // El cliente reintenta el MISMO upgrade: reutiliza la clave.
    const reintento = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );
    expect(reintento).toEqual({ status: 'ok', key: 'upgrade_previo' });

    // Y ahora entra otro destino, con el reintento todavía en curso.
    const otroDestino = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('pro'),
      TTL_MS,
      LEASE_MS,
    );

    // Sin renovar el lease, este habría entrado con clave propia y las dos
    // mutaciones habrían salido hacia Stripe.
    expect(otroDestino).toEqual({ status: 'conflict', targetPlan: 'promax' });
    expect((docData.upgradeIdempotency as any).key).toBe('upgrade_previo');
  });

  it('rechaza otro destino sobre la misma suscripción mientras pueda estar en vuelo', async () => {
    const { service, update, docData } = buildService({
      key: 'upgrade_previo',
      targetPlan: 'pro',
      subscriptionId: 'sub_123',
      createdAt: hace(5 * 1000),
    });

    const result = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );

    expect(result).toEqual({ status: 'conflict', targetPlan: 'pro' });
    // Sobrescribir aquí dejaría salir las dos mutaciones hacia Stripe.
    expect(update).not.toHaveBeenCalled();
    expect((docData.upgradeIdempotency as any).key).toBe('upgrade_previo');
  });

  it('permite otro destino pasada la ventana en vuelo, aunque siga dentro del TTL', async () => {
    // Excluir por el TTL de 24 h dejaría al cliente sin poder cambiar de plan
    // durante un día entero por un intento que quedó a medias.
    const { service, update } = buildService({
      key: 'upgrade_previo',
      targetPlan: 'pro',
      subscriptionId: 'sub_123',
      createdAt: hace(10 * 60 * 1000),
    });

    const result = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );

    expect(result).toEqual({ status: 'ok', key: 'upgrade_nuevo_promax' });
    expect(update).toHaveBeenCalled();
  });

  it('no bloquea por un intento sobre otra suscripción', async () => {
    // Otro contrato no dice nada del actual: normalmente una suscripción
    // anterior ya cancelada.
    const { service } = buildService({
      key: 'upgrade_previo',
      targetPlan: 'pro',
      subscriptionId: 'sub_viejo',
      createdAt: hace(1000),
    });

    const result = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );

    expect(result).toEqual({ status: 'ok', key: 'upgrade_nuevo_promax' });
  });

  it('persiste una clave nueva cuando la del mismo destino ya caducó', async () => {
    const { service, docData } = buildService({
      key: 'upgrade_previo',
      targetPlan: 'promax',
      subscriptionId: 'sub_123',
      createdAt: hace(TTL_MS + 1000),
    });

    const result = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );

    expect(result).toEqual({ status: 'ok', key: 'upgrade_nuevo_promax' });
    expect((docData.upgradeIdempotency as any).key).toBe(
      'upgrade_nuevo_promax',
    );
    // Se persiste como ISO string: un Date se leería mal al volver de Firestore.
    expect(typeof (docData.upgradeIdempotency as any).createdAt).toBe('string');
  });

  it('persiste la clave cuando no hay ningún intento previo', async () => {
    const { service, update } = buildService();

    const result = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );

    expect(result).toEqual({ status: 'ok', key: 'upgrade_nuevo_promax' });
    expect(update).toHaveBeenCalled();
  });

  it('evalúa la exclusión sobre un createdAt en formato Timestamp', async () => {
    // Leerlo mal degradaría la guarda en silencio y volvería el bug.
    const { service } = buildService({
      key: 'upgrade_previo',
      targetPlan: 'pro',
      subscriptionId: 'sub_123',
      createdAt: { toDate: () => new Date(Date.now() - 5 * 1000) },
    });

    const result = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );

    expect(result).toEqual({ status: 'conflict', targetPlan: 'pro' });
  });

  it('no bloquea si el createdAt almacenado es ilegible', async () => {
    // Un valor corrupto no debe dejar al usuario sin poder cambiar de plan.
    const { service } = buildService({
      key: 'upgrade_previo',
      targetPlan: 'pro',
      subscriptionId: 'sub_123',
      createdAt: 'no-es-fecha',
    });

    const result = await service.acquireUpgradeIdempotency(
      'uid-1',
      candidato('promax'),
      TTL_MS,
      LEASE_MS,
    );

    expect(result).toEqual({ status: 'ok', key: 'upgrade_nuevo_promax' });
  });
});
