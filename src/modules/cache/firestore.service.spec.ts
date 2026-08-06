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

/**
 * El sello de `updateUserSubscriptionState` ordena por cuándo llegó la respuesta
 * de Stripe, no por cuándo Stripe observó el estado: entre ambos instantes cabe
 * una red lenta, así que una relectura del plan viejo podía sellar más fresca
 * que otra del plan nuevo y revertirlo. Sin ciclos solapados el problema no se
 * plantea (issue #77).
 */
describe('FirestoreService — subscriptionSyncLock', () => {
  const LEASE_MS = 7 * 60 * 1000;

  function buildService(stored?: Record<string, unknown> | null) {
    const docData: Record<string, unknown> = stored
      ? { subscriptionSyncLock: stored }
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

  function hace(ms: number) {
    return new Date(Date.now() - ms).toISOString();
  }

  it('concede el lock cuando nadie lo tiene', async () => {
    const { service, docData } = buildService();

    const token = await service.acquireSubscriptionSyncLock('uid-1', LEASE_MS);

    expect(typeof token).toBe('string');
    expect((docData.subscriptionSyncLock as any).token).toBe(token);
  });

  it('lo niega mientras otro ciclo lo tenga vivo', async () => {
    const { service, update } = buildService({
      token: 'tok-previo',
      takenAt: hace(5 * 1000),
    });

    const token = await service.acquireSubscriptionSyncLock('uid-1', LEASE_MS);

    expect(token).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('lo concede si el lease del titular ya caducó', async () => {
    // Un proceso que murió con el lock tomado no puede dejar al usuario sin
    // sincronizar para siempre.
    const { service } = buildService({
      token: 'tok-muerto',
      takenAt: hace(30 * 60 * 1000),
    });

    const token = await service.acquireSubscriptionSyncLock('uid-1', LEASE_MS);

    expect(token).not.toBeNull();
    expect(token).not.toBe('tok-muerto');
  });

  it('lo concede si la marca almacenada es ilegible', async () => {
    const { service } = buildService({
      token: 'tok-previo',
      takenAt: 'no-es-fecha',
    });

    const token = await service.acquireSubscriptionSyncLock('uid-1', LEASE_MS);

    expect(token).not.toBeNull();
  });

  it('evalúa el lease sobre una marca en formato Timestamp', async () => {
    const { service } = buildService({
      token: 'tok-previo',
      takenAt: { toDate: () => new Date(Date.now() - 5 * 1000) },
    });

    const token = await service.acquireSubscriptionSyncLock('uid-1', LEASE_MS);

    expect(token).toBeNull();
  });

  it('libera solo si el token sigue siendo el del titular', async () => {
    const { service, docData } = buildService({
      token: 'tok-mio',
      takenAt: hace(1000),
    });

    await service.releaseSubscriptionSyncLock('uid-1', 'tok-mio');

    expect(docData.subscriptionSyncLock).toBeNull();
  });

  it('no libera el lock que otro ciclo tomó tras darlo por caducado', async () => {
    const { service, update, docData } = buildService({
      token: 'tok-de-otro',
      takenAt: hace(1000),
    });

    await service.releaseSubscriptionSyncLock('uid-1', 'tok-mio');

    expect(update).not.toHaveBeenCalled();
    expect((docData.subscriptionSyncLock as any).token).toBe('tok-de-otro');
  });
});

/**
 * Al caducar un lease su titular no se entera: una respuesta de Stripe bloqueada
 * más tiempo que el lease puede reanudarse y pisar lo que el nuevo titular ya
 * aplicó. El token viaja hasta la escritura y se comprueba en la misma
 * transacción (issue #77).
 */
describe('FirestoreService — updateUserSubscriptionState con fencing token', () => {
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
      runTransaction: (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          get: async () => ({ data: () => docData }),
          update,
        }),
    };

    return { service, update, docData };
  }

  it('aplica la escritura si el lease sigue siendo del titular', async () => {
    const { service, docData } = buildService({
      plan: 'pro',
      subscriptionSyncLock: {
        token: 'tok-mio',
        takenAt: new Date().toISOString(),
      },
    });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'promax' },
      new Date(),
      'tok-mio',
    );

    expect(aplicada).toBe(true);
    expect(docData.plan).toBe('promax');
  });

  it('descarta la escritura de un titular al que ya relevaron', async () => {
    const { service, update, docData } = buildService({
      plan: 'promax',
      subscriptionSyncLock: {
        token: 'tok-del-relevo',
        takenAt: new Date().toISOString(),
      },
    });

    // Sello más fresco que el del relevo: sin fencing, ganaría igualmente.
    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'pro' },
      new Date(Date.now() + 60 * 1000),
      'tok-caducado',
    );

    expect(aplicada).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(docData.plan).toBe('promax');
  });

  it('descarta la escritura si el lock ya no existe', async () => {
    // Liberado por el relevo, o expirado y limpiado: en ninguno de los dos casos
    // este ciclo sigue siendo el titular.
    const { service, update } = buildService({ plan: 'promax' });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'pro' },
      new Date(),
      'tok-caducado',
    );

    expect(aplicada).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('sin token se comporta como antes', async () => {
    // Las escrituras que no nacen de un ciclo con lease —ninguna hoy, pero el
    // parámetro es opcional— no deben quedar bloqueadas por un lock ajeno.
    const { service, docData } = buildService({
      plan: 'pro',
      subscriptionSyncLock: {
        token: 'de-otro',
        takenAt: new Date().toISOString(),
      },
    });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'promax' },
      new Date(),
    );

    expect(aplicada).toBe(true);
    expect(docData.plan).toBe('promax');
  });
});

/**
 * El ciclo del upgrade puede encadenar tres llamadas a Stripe cuando el update
 * acaba en error indeterminado. Renovar antes de la tercera evita dimensionar el
 * lease por las tres de golpe, que dejaría al usuario bloqueado casi veinte
 * minutos si el proceso muriera (issue #77).
 */
describe('FirestoreService — renewSubscriptionSyncLock', () => {
  function buildService(stored?: Record<string, unknown>) {
    const docData: Record<string, unknown> = stored
      ? { subscriptionSyncLock: stored }
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

  it('renueva la marca si el token sigue siendo el del titular', async () => {
    const viejo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { service, docData } = buildService({
      token: 'tok-mio',
      takenAt: viejo,
    });

    const renovado = await service.renewSubscriptionSyncLock(
      'uid-1',
      'tok-mio',
    );

    expect(renovado).toBe(true);
    expect((docData.subscriptionSyncLock as any).token).toBe('tok-mio');
    expect(
      new Date((docData.subscriptionSyncLock as any).takenAt).getTime(),
    ).toBeGreaterThan(new Date(viejo).getTime());
  });

  it('no renueva —ni pisa— el lease de quien ya nos relevó', async () => {
    const { service, update, docData } = buildService({
      token: 'tok-del-relevo',
      takenAt: new Date().toISOString(),
    });

    const renovado = await service.renewSubscriptionSyncLock(
      'uid-1',
      'tok-mio',
    );

    expect(renovado).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect((docData.subscriptionSyncLock as any).token).toBe('tok-del-relevo');
  });

  it('no renueva si el lock ya no existe', async () => {
    const { service, update } = buildService();

    const renovado = await service.renewSubscriptionSyncLock(
      'uid-1',
      'tok-mio',
    );

    expect(renovado).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * `getUsersWithHighUsage` comprobaba `hasUserReceivedEmailInPeriod` ANTES de
 * evaluar el uso, así que descartaba en silencio y el conteo que se podía sacar
 * de ahí mezclaba a todo free ya avisado con los que hoy tienen uso alto. Ahora
 * ese filtro va el último y devuelve `{ users, skipped }` (issue #60).
 */
describe('FirestoreService — getUsersWithHighUsage', () => {
  /** Dos días con 3 conversiones cada uno: cumple el patrón de uso alto. */
  const USO_ALTO = [
    ...Array.from({ length: 3 }, () => '2026-08-04T10:00:00.000Z'),
    ...Array.from({ length: 3 }, () => '2026-08-05T10:00:00.000Z'),
  ];

  /** Un solo día: no llega a los 2 días consecutivos exigidos. */
  const USO_BAJO = ['2026-08-05T10:00:00.000Z'];

  function usuario(id: string, conversiones = USO_ALTO, plan = 'free') {
    return {
      id,
      conversiones,
      data: {
        email: `${id}@ejemplo.com`,
        displayName: `User ${id}`,
        country: 'MX',
        plan,
        // Con el límite free en 10 PDFs, 6 usados y 3/día de media, la
        // proyección son 2 días: entra dentro de la ventana de 14.
        pdfCount: 6,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-09-01T00:00:00.000Z'),
      },
    };
  }

  /**
   * Mockea Firestore según el patrón de acceso NUEVO: una consulta a
   * `conversion_history` por rango de fecha, una lectura en lote de los
   * usuarios que salgan de ahí, y `email_queue` solo para los candidatos.
   *
   * Registra cada acceso para poder afirmar la FORMA del acceso, no solo su
   * resultado: el issue #82 va justo de eso.
   */
  function buildService(
    usuarios: ReturnType<typeof usuario>[],
    yaAvisados: string[] = [],
  ) {
    const accesos = {
      conversiones: 0,
      escaneosDeUsuarios: 0,
      lotesDeUsuarios: [] as string[][],
      emails: [] as string[],
    };
    const service: any = Object.create(FirestoreService.prototype);
    service.usersCollection = 'users';
    service.historyCollection = 'conversion_history';
    service.emailQueueCollection = 'email_queue';
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const docDeUsuario = (id: string) => {
      const u = usuarios.find((x) => x.id === id);
      return { id, exists: !!u, data: () => u?.data };
    };

    service.firestore = {
      getAll: async (...refs: Array<{ id: string }>) => {
        accesos.lotesDeUsuarios.push(refs.map((r) => r.id));
        return refs.map((r) => docDeUsuario(r.id));
      },
      collection: (nombre: string) => {
        const filtros: Array<{ campo: string; valor: unknown }> = [];
        const q: any = {
          doc: (id: string) => ({ id }),
          where: (campo: string, _op: string, valor: unknown) => {
            filtros.push({ campo, valor });
            return q;
          },
          select: () => q,
          orderBy: () => q,
          limit: () => q,
          get: async () => {
            if (nombre === 'conversion_history') {
              accesos.conversiones++;
              const docs = usuarios.flatMap((u) =>
                u.conversiones.map((iso) => ({
                  data: () => ({
                    userId: u.id,
                    status: 'completed',
                    createdAt: new Date(iso),
                  }),
                })),
              );
              return { docs, empty: docs.length === 0 };
            }

            if (nombre === 'users') {
              // El escaneo del censo completo es justo lo que #82 elimina.
              accesos.escaneosDeUsuarios++;
              const docs = usuarios.map((u) => ({
                id: u.id,
                exists: true,
                data: () => u.data,
              }));
              return { docs, empty: docs.length === 0 };
            }

            // email_queue: solo importa si hay o no algún documento.
            const userId = filtros.find((f) => f.campo === 'userId')
              ?.valor as string;
            accesos.emails.push(userId);
            const avisado = yaAvisados.includes(userId);
            return { docs: avisado ? [{}] : [], empty: !avisado };
          },
        };
        return q;
      },
    };

    return { service, accesos };
  }

  const params = { minPdfsPerDay: 3, consecutiveDays: 2 };

  it('cuenta como descartado a quien tiene uso alto pero ya recibió el email', async () => {
    // 5 candidatos con uso alto, de los cuales 3 ya fueron avisados.
    const { service } = buildService(
      ['a', 'b', 'c', 'd', 'e'].map((id) => usuario(id)),
      ['a', 'b', 'c'],
    );

    const resultado = await service.getUsersWithHighUsage(params);

    expect(resultado.users).toHaveLength(2);
    expect(resultado.skipped.alreadyReceived).toBe(3);
    expect(resultado.users.map((u: any) => u.userId).sort()).toEqual([
      'd',
      'e',
    ]);
  });

  it('no cuenta como descartado a quien simplemente no tiene uso alto', async () => {
    // Un no-candidato no es un descarte: si contara, `skipped` acabaría
    // reportando casi toda la base free y dejaría de significar nada.
    const { service } = buildService([
      usuario('activo'),
      usuario('flojo', USO_BAJO),
      usuario('inactivo', []),
    ]);

    const resultado = await service.getUsersWithHighUsage(params);

    expect(resultado.users).toHaveLength(1);
    expect(resultado.skipped.alreadyReceived).toBe(0);
  });

  it('ignora a los ya avisados que hoy no tienen uso alto', async () => {
    // El caso que hacía inservible el conteo con el filtro por delante: un free
    // avisado el mes pasado y hoy inactivo entraba en `skipped` igual que quien
    // de verdad merecía el email. Aquí solo cuenta 'activo'.
    const { service } = buildService(
      [
        usuario('activo'),
        usuario('avisado-y-flojo', USO_BAJO),
        usuario('avisado-e-inactivo', []),
      ],
      ['activo', 'avisado-y-flojo', 'avisado-e-inactivo'],
    );

    const resultado = await service.getUsersWithHighUsage(params);

    expect(resultado.users).toHaveLength(0);
    expect(resultado.skipped.alreadyReceived).toBe(1);
  });

  it('comprueba el envío previo solo para quien cumple el patrón de uso', async () => {
    const { service, accesos } = buildService([
      usuario('activo'),
      usuario('flojo', USO_BAJO),
      usuario('inactivo', []),
    ]);

    await service.getUsersWithHighUsage(params);

    expect(accesos.emails).toEqual(['activo']);
  });

  it('respeta el tope sin contar como descartados a los que no llegó a examinar', async () => {
    const { service } = buildService(
      Array.from({ length: 10 }, (_, i) => usuario(`u${i}`)),
    );

    const resultado = await service.getUsersWithHighUsage({
      ...params,
      limit: 3,
    });

    expect(resultado.users).toHaveLength(3);
    expect(resultado.skipped.alreadyReceived).toBe(0);
    // Y lo dice: 3 de 10 devueltos no puede pasar por "no había más".
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('tope de 3'),
    );
  });

  /**
   * El corazón del issue #82. La versión anterior recorría el censo entero de
   * usuarios free lanzando una consulta por cabeza, en serie — 1.920 consultas
   * en producción para 147 conversiones en la ventana. Y ni siquiera podía
   * terminar: aquella consulta combinaba dos igualdades con un rango sin el
   * índice compuesto que eso exige.
   */
  describe('forma del acceso a Firestore (issue #82)', () => {
    it('no escanea el censo de usuarios ni lanza una consulta de conversiones por cabeza', async () => {
      const { service, accesos } = buildService(
        Array.from({ length: 50 }, (_, i) => usuario(`u${i}`)),
      );

      await service.getUsersWithHighUsage(params);

      // Una sola consulta de conversiones para los 50, no 50.
      expect(accesos.conversiones).toBe(1);
      expect(accesos.escaneosDeUsuarios).toBe(0);
    });

    it('lee los usuarios candidatos en lote, no uno a uno', async () => {
      const { service, accesos } = buildService(
        Array.from({ length: 12 }, (_, i) => usuario(`u${i}`)),
      );

      await service.getUsersWithHighUsage(params);

      expect(accesos.lotesDeUsuarios).toHaveLength(1);
      expect(accesos.lotesDeUsuarios[0]).toHaveLength(12);
    });

    it('no lee ningún usuario si la ventana no deja candidatos', async () => {
      // Sin candidatos no hay nada que resolver: ni lote, ni email_queue.
      const { service, accesos } = buildService([
        usuario('flojo', USO_BAJO),
        usuario('inactivo', []),
      ]);

      const resultado = await service.getUsersWithHighUsage(params);

      expect(resultado.users).toHaveLength(0);
      expect(accesos.lotesDeUsuarios).toHaveLength(0);
      expect(accesos.emails).toHaveLength(0);
    });

    it('descarta a quien ya no es free: partir de conversiones no filtra el plan', async () => {
      // La consulta anterior filtraba `plan == free` en Firestore. Ahora se parte
      // de conversiones, que no saben de planes, así que el filtro tiene que
      // aplicarse tras leer el documento — o el email de la cuota gratuita
      // acabaría en la bandeja de un usuario de pago.
      const { service } = buildService([
        usuario('gratis'),
        usuario('pagado', USO_ALTO, 'pro'),
        usuario('maximo', USO_ALTO, 'promax'),
      ]);

      const resultado = await service.getUsersWithHighUsage(params);

      expect(resultado.users.map((u: any) => u.userId)).toEqual(['gratis']);
    });

    it('con más candidatos que cupo, atiende primero a los de uso más intenso', async () => {
      // El tope ya no se lo lleva quien apareciera antes en el censo —azar—,
      // sino quien está más cerca de agotar la cuota.
      const intenso = usuario('intenso', [
        ...Array.from({ length: 9 }, () => '2026-08-04T10:00:00.000Z'),
        ...Array.from({ length: 9 }, () => '2026-08-05T10:00:00.000Z'),
      ]);
      const { service } = buildService([
        usuario('justo'),
        intenso,
        usuario('otro'),
      ]);

      const resultado = await service.getUsersWithHighUsage({
        ...params,
        limit: 1,
      });

      expect(resultado.users.map((u: any) => u.userId)).toEqual(['intenso']);
    });

    it('ignora las conversiones fallidas al medir el uso', async () => {
      // `status` se filtra en memoria para no volver a exigir índice compuesto;
      // el resultado tiene que ser el mismo que filtrándolo en la consulta.
      const { service } = buildService([usuario('activo')]);
      const original = service.firestore.collection;
      service.firestore.collection = (nombre: string) => {
        const q = original(nombre);
        if (nombre !== 'conversion_history') return q;
        const get = q.get;
        q.get = async () => {
          const res = await get();
          return {
            ...res,
            docs: res.docs.map((d: any) => ({
              data: () => ({ ...d.data(), status: 'failed' }),
            })),
          };
        };
        return q;
      };

      const resultado = await service.getUsersWithHighUsage(params);

      expect(resultado.users).toHaveLength(0);
    });
  });
});

/**
 * El evento de baja se escribe DENTRO de la transacción que degrada al usuario.
 *
 * Escribirlo después dejaba dos desenlaces malos: si esa segunda escritura
 * fallaba, la reentrega del webhook encontraba al usuario ya en Free, lo tomaba
 * por trabajo hecho y la baja no se contabilizaba nunca; y registrándolo antes,
 * un fencing que descartase la degradación habría contado un churn que no
 * ocurrió. Dentro de la transacción constan ambas cosas o ninguna.
 */
describe('FirestoreService — la baja y su evento van en la misma transacción', () => {
  function buildService(docData: Record<string, unknown>) {
    const update = jest
      .fn()
      .mockImplementation((_ref: unknown, data: Record<string, unknown>) => {
        Object.assign(docData, data);
      });
    const set = jest.fn();
    const docs: Record<string, unknown> = {};

    const service: any = Object.create(FirestoreService.prototype);
    service.usersCollection = 'users';
    service.subscriptionEventsCollection = 'subscription_events';
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.firestore = {
      collection: (name: string) => ({
        doc: (id?: string) => {
          const ref = { collection: name, id };
          docs[`${name}/${id ?? 'uid-1'}`] = ref;
          return ref;
        },
      }),
      runTransaction: (fn: (t: unknown) => Promise<boolean>) =>
        fn({
          get: async () => ({ data: () => docData }),
          update,
          set,
        }),
    };

    return { service, update, set };
  }

  const evento = {
    id: 'sub_event_20260806_ABCDE',
    userId: 'uid-1',
    userEmail: 'cliente@example.com',
    eventType: 'churned' as const,
    plan: 'lite' as const,
    currency: 'mxn' as const,
    mrr: 0,
    mrrMxn: 0,
    stripeSubscriptionId: 'sub_123',
    createdAt: new Date('2026-08-06T10:00:00.000Z'),
  };

  it('escribe el evento junto al cambio de plan', async () => {
    const { service, update, set } = buildService({ plan: 'lite' });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'free', stripeSubscriptionId: null },
      new Date('2026-08-06T10:00:00.000Z'),
      undefined,
      evento,
    );

    expect(aplicada).toBe(true);
    expect(update).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'subscription_events' }),
      expect.objectContaining({ eventType: 'churned', plan: 'lite' }),
    );
  });

  it('no escribe el evento si el fencing descarta la degradación', async () => {
    const { service, update, set } = buildService({
      plan: 'promax',
      subscriptionSyncedAt: '2026-08-06T10:00:05.000Z',
    });

    const aplicada = await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'free', stripeSubscriptionId: null },
      new Date('2026-08-06T10:00:00.000Z'),
      undefined,
      evento,
    );

    // Contarlo aquí habría registrado la baja de un cliente que sigue pagando.
    expect(aplicada).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('no toca la colección de eventos cuando no hay baja que registrar', async () => {
    const { service, set } = buildService({ plan: 'pro' });

    await service.updateUserSubscriptionState(
      'uid-1',
      { plan: 'promax' },
      new Date('2026-08-06T10:00:00.000Z'),
    );

    expect(set).not.toHaveBeenCalled();
  });
});
