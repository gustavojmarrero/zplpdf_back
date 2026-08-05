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
