// Evitar la conexión real a Stripe al cargar el módulo.
jest.mock('stripe', () => jest.fn());

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service.js';

/**
 * Un fallo de permisos de la API key de Stripe (restricted key sin el scope
 * `subscription_write`) escapaba sin capturar de `upgradeSubscription`, así que
 * el cliente recibía un 500 opaco y reintentaba en bucle creyendo que el error
 * era suyo. Un fallo de configuración debe distinguirse de un error del usuario.
 */
describe('PaymentsService — upgradeSubscription', () => {
  const PROMAX_MXN = 'price_promax_mxn';
  const PRO_MXN = 'price_pro_mxn';
  const LITE_MXN = 'price_lite_mxn';

  /**
   * El constructor de PaymentsService abre conexiones (Stripe, Firestore) que
   * estos tests no ejercitan. Instanciamos por prototipo e inyectamos solo las
   * dependencias que toca el método.
   */
  function buildService(overrides: {
    subscription?: unknown;
    retrieveError?: unknown;
    updateError?: unknown;
    /**
     * Suscripción que devuelve Stripe DESPUÉS del cambio de precio. Por defecto
     * queda activa; los tests que simulan un cobro fallido la pasan en past_due.
     */
    updateResult?: unknown;
    syncTaxProfileToStripe?: jest.Mock;
    /** `null` simula que otro ciclo tiene el mutex de sincronización. */
    syncLockToken?: string | null;
  }) {
    const retrieve = overrides.retrieveError
      ? jest.fn().mockRejectedValue(overrides.retrieveError)
      : jest.fn().mockResolvedValue(overrides.subscription);
    const update = overrides.updateError
      ? jest.fn().mockRejectedValue(overrides.updateError)
      : jest
          .fn()
          .mockResolvedValue(
            overrides.updateResult ?? { status: 'active', id: 'sub_123' },
          );
    // Documento con estado real: la clave de idempotencia se persiste en el
    // usuario y debe sobrevivir entre intentos, así que un mock sin memoria no
    // podría distinguir "reusa la clave" de "genera otra".
    const userDoc: Record<string, unknown> = {
      id: 'uid-1',
      plan: 'pro',
      country: 'MX',
      stripeSubscriptionId: 'sub_123',
    };
    const updateUser = jest
      .fn()
      .mockImplementation(async (_id: string, data: object) => {
        Object.assign(userDoc, data);
      });
    const getUserById = jest.fn().mockImplementation(async () => ({
      ...userDoc,
    }));

    /**
     * Reproduce la semántica transaccional real: reutiliza la clave vigente del
     * mismo destino RENOVANDO su lease, rechaza un destino distinto mientras el
     * anterior siga vivo, y en el resto de casos persiste la candidata. Las dos
     * ventanas se evalúan sobre marcas distintas y sobre el valor almacenado tal
     * cual, para que un `createdAt` mal serializado se note.
     */
    const acquireUpgradeIdempotency = jest.fn().mockImplementation(
      async (
        _id: string,
        candidate: {
          key: string;
          targetPlan: string;
          subscriptionId: string;
        },
        ttlMs: number,
        leaseMs: number,
      ) => {
        const stored = userDoc.upgradeIdempotency as
          | Record<string, any>
          | null
          | undefined;
        const enMs = (value: any) =>
          value ? new Date(value?.toDate?.() ?? value).getTime() : NaN;
        const createdAtMs = enMs(stored?.createdAt);
        const lastAttemptMs = enMs(stored?.lastAttemptAt ?? stored?.createdAt);
        const ahora = new Date().toISOString();
        const mismoContrato =
          !!stored?.key &&
          Number.isFinite(createdAtMs) &&
          stored.subscriptionId === candidate.subscriptionId;

        if (mismoContrato && stored.targetPlan === candidate.targetPlan) {
          if (Date.now() - createdAtMs < ttlMs) {
            userDoc.upgradeIdempotency = { ...stored, lastAttemptAt: ahora };
            return { status: 'ok', key: stored.key };
          }
        } else if (
          mismoContrato &&
          Number.isFinite(lastAttemptMs) &&
          Date.now() - lastAttemptMs < leaseMs
        ) {
          return { status: 'conflict', targetPlan: stored.targetPlan };
        }

        userDoc.upgradeIdempotency = {
          ...candidate,
          createdAt: ahora,
          lastAttemptAt: ahora,
        };
        return { status: 'ok', key: candidate.key };
      },
    );

    const releaseUpgradeIdempotency = jest
      .fn()
      .mockImplementation(async (_id: string, key: string) => {
        const stored = userDoc.upgradeIdempotency as
          | Record<string, any>
          | null
          | undefined;
        // Compare-and-delete: no pisar la clave de un intento posterior.
        if (stored?.key === key) {
          userDoc.upgradeIdempotency = null;
        }
      });

    const syncTaxProfileToStripe =
      overrides.syncTaxProfileToStripe ??
      jest.fn().mockResolvedValue(undefined);

    /**
     * El plan se escribe por la variante con guarda de versión (issue #74).
     * Delega en `updateUser` para que las aserciones sobre escrituras de plan
     * sigan viendo todas las escrituras por un único punto; `true` = aplicada,
     * que es el caso cuando no hay una lectura posterior compitiendo.
     */
    const updateUserSubscriptionState = jest
      .fn()
      .mockImplementation(async (id: string, data: object) => {
        await updateUser(id, data);
        return true;
      });

    /**
     * El upgrade entra en el mismo mutex que el webhook (issue #77): los dos
     * observan Stripe y escriben el plan.
     *
     * Con estado real, no concediendo siempre el mismo token: un mock permisivo
     * dejaría entrar a dos ciclos a la vez, que es justo lo que el mutex impide,
     * y las pruebas de concurrencia estarían midiendo un mundo que no existe.
     */
    let lockVivo: string | null = null;
    const acquireSubscriptionSyncLock = jest
      .fn()
      .mockImplementation(async () => {
        if (overrides.syncLockToken === null) {
          return null;
        }
        if (lockVivo) {
          return null;
        }
        lockVivo = overrides.syncLockToken ?? 'sync-tok';
        return lockVivo;
      });
    const releaseSubscriptionSyncLock = jest
      .fn()
      .mockImplementation(async (_id: string, token: string) => {
        // Compare-and-delete, igual que la implementación real.
        if (lockVivo === token) {
          lockVivo = null;
        }
      });
    // Renueva solo si el token sigue siendo el del titular.
    const renewSubscriptionSyncLock = jest
      .fn()
      .mockImplementation(
        async (_id: string, token: string) => lockVivo === token,
      );

    const service: any = Object.create(PaymentsService.prototype);
    service.stripe = { subscriptions: { retrieve, update } };
    service.firestoreService = {
      getUserById,
      updateUser,
      updateUserSubscriptionState,
      acquireUpgradeIdempotency,
      releaseUpgradeIdempotency,
      acquireSubscriptionSyncLock,
      releaseSubscriptionSyncLock,
      renewSubscriptionSyncLock,
    };
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.promaxPriceIdMxn = PROMAX_MXN;
    // Sin estos, el precio vigente no se resuelve y el upgrade falla cerrado.
    service.proPriceIdMxn = PRO_MXN;
    service.litePriceIdMxn = LITE_MXN;
    // El upgrade emite y cobra la factura de la proración dentro del update, así
    // que propaga el perfil fiscal antes y en modo estricto.
    service.billingService = { syncTaxProfileToStripe: syncTaxProfileToStripe };

    return {
      service,
      syncTaxProfileToStripe,
      retrieve,
      update,
      updateUser,
      updateUserSubscriptionState,
      getUserById,
      userDoc,
      acquireUpgradeIdempotency,
      releaseUpgradeIdempotency,
      acquireSubscriptionSyncLock,
      releaseSubscriptionSyncLock,
      renewSubscriptionSyncLock,
    };
  }

  /**
   * `updateUser` se usa también para persistir la clave de idempotencia, así que
   * "no se tocó el plan" ya no equivale a "no se llamó a updateUser".
   */
  function escriturasDePlan(updateUser: jest.Mock) {
    return updateUser.mock.calls.filter(([, data]) => data && 'plan' in data);
  }

  function claveUsada(update: jest.Mock, llamada = 0) {
    return update.mock.calls[llamada]?.[2]?.idempotencyKey;
  }

  // Con precio: el upgrade falla cerrado si no puede resolver de qué plan parte,
  // así que una suscripción sin `price` ya no es un fixture realista.
  const activeSubscription = {
    status: 'active',
    items: { data: [{ id: 'si_123', price: { id: PRO_MXN } }] },
  };

  /** Para los casos que arrancan en Lite, donde ambos destinos son válidos. */
  const liteSubscription = {
    status: 'active',
    items: { data: [{ id: 'si_123', price: { id: LITE_MXN } }] },
  };

  it('sube el plan y aplica el precio de la moneda del usuario', async () => {
    const { service, update, updateUser } = buildService({
      subscription: activeSubscription,
    });

    const result = await service.upgradeSubscription('uid-1', 'promax');

    expect(result.success).toBe(true);
    expect(update).toHaveBeenCalledWith(
      'sub_123',
      expect.objectContaining({
        items: [{ id: 'si_123', price: PROMAX_MXN }],
        proration_behavior: 'always_invoice',
        // Sin esto Stripe aplicaría el cambio aunque el cobro sea rechazado.
        // error_if_incomplete NO vale: rompe las tarjetas con 3DS.
        payment_behavior: 'pending_if_incomplete',
      }),
      // Un doble envío no debe traducirse en un segundo cargo.
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(updateUser).toHaveBeenCalledWith('uid-1', { plan: 'promax' });
  });

  /**
   * `updateUser` guarda un Date anidado como Timestamp de Firestore, y
   * `getUserById` solo convierte los de primer nivel. Si `createdAt` volviera
   * como Timestamp, `new Date(...)` daría Invalid Date, el TTL sería NaN y la
   * clave no se reutilizaría jamás: la idempotencia quedaría inservible.
   */
  it('reutiliza la clave aunque Firestore devuelva createdAt como Timestamp', async () => {
    const { service, update, userDoc, retrieve } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeConnectionError', message: 'timeout' },
    });
    retrieve.mockResolvedValue(activeSubscription);

    await service.upgradeSubscription('uid-1', 'promax').catch(() => undefined);

    // Simula el viaje de ida y vuelta por Firestore: el ISO string vuelve
    // envuelto en un Timestamp con toDate().
    const guardado = userDoc.upgradeIdempotency as Record<string, any>;
    const comoTimestamp = new Date(guardado.createdAt);
    userDoc.upgradeIdempotency = {
      ...guardado,
      createdAt: { toDate: () => comoTimestamp },
    };

    await service.upgradeSubscription('uid-1', 'promax').catch(() => undefined);

    expect(claveUsada(update, 0)).toBe(claveUsada(update, 1));
  });

  it('persiste createdAt como ISO string, no como Date', async () => {
    const { service, userDoc, retrieve } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeConnectionError', message: 'timeout' },
    });
    retrieve.mockResolvedValue(activeSubscription);

    await service.upgradeSubscription('uid-1', 'promax').catch(() => undefined);

    const guardado = userDoc.upgradeIdempotency as Record<string, any>;
    expect(typeof guardado.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(guardado.createdAt))).toBe(false);
  });

  /**
   * Dos upgrades simultáneos leyendo un usuario sin clave generarían UUIDs
   * distintos y dos mutaciones en Stripe — el doble cargo que la idempotencia
   * debe evitar. La adquisición tiene que ser atómica.
   */
  it('adquiere la clave de forma atómica, no leyendo y escribiendo por separado', async () => {
    const { service, acquireUpgradeIdempotency, getUserById } = buildService({
      subscription: activeSubscription,
    });

    await service.upgradeSubscription('uid-1', 'promax');

    expect(acquireUpgradeIdempotency).toHaveBeenCalledWith(
      'uid-1',
      expect.objectContaining({
        key: expect.any(String),
        targetPlan: 'promax',
        subscriptionId: 'sub_123',
      }),
      // TTL de reutilización (24 h) y lease de exclusión entre destinos
      // distintos (minutos): son dos cosas y no pueden ser el mismo número. El
      // lease cubre el peor caso de `subscriptions.update`: 3 × 80 s de timeout
      // más 2 × 60 s de Retry-After = 360 s.
      24 * 60 * 60 * 1000,
      7 * 60 * 1000,
    );
    // La clave no se decide a partir del usuario leído antes de la transacción.
    // Dos lecturas: la inicial y la revalidación dentro del mutex, que existe
    // porque entre ambas cabe otro cambio ya aplicado (issue #77).
    expect(getUserById).toHaveBeenCalledTimes(2);
  });

  /**
   * Antes del mutex (issue #77), dos upgrades concurrentes llegaban los dos a
   * Stripe y solo la clave compartida evitaba el doble cargo. Ahora el segundo
   * ni siquiera entra: el mutex lo rechaza con 409 antes de mover dinero. Esa es
   * la garantía fuerte, y la clave queda como red de seguridad para los
   * reintentos secuenciales, que sí comparten clave.
   */
  it('dos upgrades concurrentes: uno pasa y el otro recibe 409 sin tocar Stripe', async () => {
    const { service, update } = buildService({
      subscription: activeSubscription,
    });

    const resultados = await Promise.allSettled([
      service.upgradeSubscription('uid-1', 'promax'),
      service.upgradeSubscription('uid-1', 'promax'),
    ]);

    const cumplidos = resultados.filter((r) => r.status === 'fulfilled');
    const rechazados = resultados.filter((r) => r.status === 'rejected');
    expect(cumplidos).toHaveLength(1);
    expect(rechazados).toHaveLength(1);
    expect((rechazados[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    // Una sola mutación: el rechazo ocurre antes de llamar a Stripe.
    expect(update).toHaveBeenCalledTimes(1);
  });

  /**
   * Dos destinos distintos no pueden compartir clave de idempotencia, así que
   * Stripe procesaría ambas mutaciones: la suscripción acabaría en la que
   * llegara última —con una proración que el usuario no pidió— y Firestore en la
   * que terminara última, que no tiene por qué ser la misma (issue #73).
   */
  it('rechaza un segundo upgrade a otro destino mientras el primero sigue en curso', async () => {
    const { service, update, userDoc } = buildService({
      subscription: liteSubscription,
    });
    // Desde lite ambos destinos son upgrades válidos: el caso de las dos
    // pestañas con botones distintos.
    userDoc.plan = 'lite';

    const resultados = await Promise.allSettled([
      service.upgradeSubscription('uid-1', 'pro'),
      service.upgradeSubscription('uid-1', 'promax'),
    ]);

    const rechazados = resultados.filter((r) => r.status === 'rejected');
    expect(rechazados).toHaveLength(1);
    expect((rechazados[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    // Lo que importa no es el 409, sino que solo una mutación llegue a Stripe.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('permite cambiar de destino cuando el intento anterior ya no puede estar vivo', async () => {
    const { service, update, userDoc } = buildService({
      subscription: liteSubscription,
    });
    userDoc.plan = 'lite';
    // Intento anterior a otro plan, de hace media hora: el lease expiró hace
    // mucho. Sigue dentro del TTL de 24 h, y ahí está la trampa — usar el TTL
    // para excluir dejaría al cliente sin poder cambiar de plan durante un día.
    const haceMediaHora = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    userDoc.upgradeIdempotency = {
      key: 'upgrade_uid-1_viejo',
      targetPlan: 'pro',
      subscriptionId: 'sub_123',
      createdAt: haceMediaHora,
      lastAttemptAt: haceMediaHora,
    };

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).resolves.toMatchObject({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
    // Clave nueva: la del intento caducado no protege de nada aquí.
    expect(claveUsada(update, 0)).not.toBe('upgrade_uid-1_viejo');
  });

  /**
   * El plan se valida antes de la sincronización fiscal, y en ese hueco otro
   * cambio puede completarse. Sin revalidar dentro del mutex, un lite→pro
   * demorado entraría después de un lite→promax ya aplicado y BAJARÍA la
   * suscripción, violando la garantía de upgrade estricto (issue #77).
   */
  it('revalida el plan dentro del mutex y aborta si otro cambio ya subió más', async () => {
    const { service, update, userDoc, getUserById } = buildService({
      subscription: liteSubscription,
    });
    userDoc.plan = 'lite';

    // La primera lectura ve lite; para cuando se revalida, otro upgrade ya
    // dejó al usuario en promax.
    getUserById
      .mockResolvedValueOnce({ ...userDoc, plan: 'lite' })
      .mockResolvedValueOnce({ ...userDoc, plan: 'promax' });

    await expect(service.upgradeSubscription('uid-1', 'pro')).rejects.toThrow(
      BadRequestException,
    );
    // Lo que importa: la suscripción no baja de promax a pro.
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * Firestore refleja lo que los webhooks alcanzaron a escribir, no lo que
   * Stripe tiene ahora. Un upgrade que dejó un `pending_update` esperando pago
   * NO cambia el plan en Firestore, así que releer solo el documento no lo ve; y
   * lanzar otro update reemplazaría ese pending update, anulando su factura y
   * dejando al cliente con un enlace de pago muerto.
   */
  it('aborta si Stripe tiene un pending update, aunque Firestore no lo refleje', async () => {
    const { service, update, retrieve } = buildService({
      subscription: activeSubscription,
    });
    retrieve.mockResolvedValueOnce(activeSubscription).mockResolvedValueOnce({
      status: 'active',
      items: { data: [{ id: 'si_123' }] },
      pending_update: { expires_at: 123 },
      latest_invoice: { hosted_invoice_url: 'https://pay.stripe.com/x' },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('aborta si Stripe ya tiene la suscripción en el plan de destino', async () => {
    // La comprobación que de verdad impide bajar de plan: el plan efectivo lo
    // dicta el precio que Stripe tiene puesto, no el documento.
    const { service, update, retrieve } = buildService({
      subscription: activeSubscription,
    });
    retrieve.mockResolvedValueOnce(activeSubscription).mockResolvedValueOnce({
      status: 'active',
      items: { data: [{ id: 'si_123', price: { id: PROMAX_MXN } }] },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('aborta si la suscripción dejó de estar activa mientras se preparaba', async () => {
    const { service, update, retrieve } = buildService({
      subscription: activeSubscription,
    });
    retrieve
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValueOnce({ status: 'past_due', items: { data: [{}] } });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * El cobro ya pasó y no se puede deshacer, pero la escritura se descartó
   * porque otro ciclo relevó el lease. Responder éxito dejaría al cliente con el
   * producto sin reconocerle el plan que acaba de pagar.
   */
  it('no afirma éxito si el fencing descarta la escritura tras cobrar', async () => {
    const { service, updateUserSubscriptionState } = buildService({
      subscription: activeSubscription,
    });
    updateUserSubscriptionState.mockResolvedValue(false);

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    // El mensaje reconoce el cobro: negarlo sería mentir sobre dinero cobrado.
    expect(error.message).toContain('went through');

    // Y el discriminador, que es lo que el cliente debe mirar: este endpoint
    // devuelve 503 también SIN cobro —sync fiscal fallido, reconciliación
    // indeterminada—, así que deducirlo del status sería afirmar un cargo
    // inexistente en dos de los tres casos.
    const respuesta = (error as ServiceUnavailableException).getResponse() as {
      error: string;
      data: { paymentProcessed: boolean };
    };
    expect(respuesta.error).toBe('UPGRADE_APPLIED_SYNC_PENDING');
    expect(respuesta.data.paymentProcessed).toBe(true);
  });

  it('los 503 anteriores al cobro NO llevan el discriminador de pago procesado', async () => {
    // Si el sync fiscal falla no se ha cobrado nada; confundirlo con el caso de
    // arriba haría que el cliente informara de un cargo que no existe.
    const { service } = buildService({
      subscription: activeSubscription,
      syncTaxProfileToStripe: jest.fn().mockRejectedValue(new Error('caído')),
    });

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const respuesta = (error as ServiceUnavailableException).getResponse();
    expect(JSON.stringify(respuesta)).not.toContain('paymentProcessed');
    expect(JSON.stringify(respuesta)).not.toContain(
      'UPGRADE_APPLIED_SYNC_PENDING',
    );
  });

  /**
   * Mismo caso de configuración que el webhook trata como CRITICAL sin tocar el
   * plan: si no se sabe de qué plan se parte, no se puede afirmar que esto sea
   * una subida, y facturar a ciegas es peor que rechazar.
   */
  it('falla cerrado si el precio vigente en Stripe no mapea a ningún plan', async () => {
    const { service, update, retrieve } = buildService({
      subscription: activeSubscription,
    });
    retrieve.mockResolvedValueOnce(activeSubscription).mockResolvedValueOnce({
      status: 'active',
      items: {
        data: [{ id: 'si_123', price: { id: 'price_que_nadie_conoce' } }],
      },
    });

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain('Nothing was charged');
    expect(update).not.toHaveBeenCalled();
  });

  it('no reconcilia si el lease ya no es nuestro', async () => {
    // Reconciliar exigiría una tercera llamada a Stripe; si nos relevaron, la
    // escritura se descartaría igual y quien tenga el ciclo leerá el estado real.
    const { service, updateUser, renewSubscriptionSyncLock } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeConnectionError', message: 'network error' },
    });
    renewSubscriptionSyncLock.mockResolvedValue(false);

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain('could not confirm');
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
  });

  it('aborta si la suscripción cambió mientras se preparaba el upgrade', async () => {
    const { service, update, userDoc, getUserById } = buildService({
      subscription: activeSubscription,
    });

    getUserById
      .mockResolvedValueOnce({ ...userDoc })
      .mockResolvedValueOnce({ ...userDoc, stripeSubscriptionId: 'sub_otra' });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it('no toca Stripe si otro ciclo tiene el mutex de sincronización', async () => {
    // Un webhook en curso puede estar observando el estado ahora mismo.
    const { service, update } = buildService({
      subscription: activeSubscription,
      syncLockToken: null,
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it('libera el mutex de sincronización al terminar', async () => {
    const { service, releaseSubscriptionSyncLock } = buildService({
      subscription: activeSubscription,
    });

    await service.upgradeSubscription('uid-1', 'promax');

    expect(releaseSubscriptionSyncLock).toHaveBeenCalledWith(
      'uid-1',
      'sync-tok',
    );
  });

  it('libera la clave comparando, sin pisar la de un intento posterior', async () => {
    const { service, releaseUpgradeIdempotency, userDoc } = buildService({
      subscription: activeSubscription,
    });

    await service.upgradeSubscription('uid-1', 'promax');

    const [, claveLiberada] = releaseUpgradeIdempotency.mock.calls[0];
    expect(typeof claveLiberada).toBe('string');
    expect(userDoc.upgradeIdempotency).toBeNull();
  });

  it('devuelve 503 —no 500— si la API key no tiene permisos para modificar la suscripción', async () => {
    const { service, updateUser } = buildService({
      subscription: activeSubscription,
      updateError: {
        statusCode: 403,
        message:
          "Permission denied. The provided key 'rk_live_***' does not have the required permissions",
      },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(ServiceUnavailableException);

    // El plan NO debe cambiar en Firestore si Stripe rechazó el cambio.
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
    // El log debe ser CRITICAL y nombrar la env var, para que sea accionable.
    expect(service.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL'),
    );
    expect(service.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('STRIPE_SECRET_KEY'),
    );
    // Un 403 se arregla editando los scopes de la key, no rotándola.
    expect(service.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('scopes'),
    );
  });

  it('ante un 401 pide rotar la clave, no revisar scopes', async () => {
    const { service } = buildService({
      subscription: activeSubscription,
      updateError: { statusCode: 401, message: 'Invalid API Key provided' },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(ServiceUnavailableException);

    // Una credencial inválida y una sin permisos se arreglan en sitios distintos:
    // confundirlas manda al equipo a buscar donde no es durante una caída.
    const logged = service.logger.error.mock.calls[0][0];
    expect(logged).toContain('rotar');
    expect(logged).not.toContain('scopes');
  });

  it('también captura el fallo de permisos al leer la suscripción', async () => {
    const { service, update } = buildService({
      retrieveError: { statusCode: 401, message: 'Invalid API Key provided' },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(update).not.toHaveBeenCalled();
  });

  it('propaga el rechazo de la tarjeta como error del usuario (400)', async () => {
    const { service, updateUser } = buildService({
      subscription: activeSubscription,
      updateError: {
        statusCode: 402,
        type: 'StripeCardError',
        message: 'Your card was declined.',
      },
    });

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    // Tras un cobro rechazado lo primero que necesita saber el cliente es que
    // sigue en su plan de antes, no solo que la tarjeta falló.
    expect(error.message).toContain('has not been changed');
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
  });

  /**
   * Caso del cliente sistemas@prodisab2b.com (issue #66): `subscriptions.update`
   * no lanza cuando el cobro de la proración se rechaza — Stripe cambia el
   * precio, deja la suscripción en past_due y responde 200. El plan acababa
   * marcado en Firestore sin haberse pagado.
   */
  it('no marca el plan si la suscripción no queda activa tras el cambio', async () => {
    const { service, updateUser } = buildService({
      subscription: activeSubscription,
      updateResult: { status: 'past_due', id: 'sub_123' },
    });

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('past_due');
    expect(error.message).toContain('has not been changed');
    // Lo esencial: el usuario NO queda en promax sin haberlo pagado.
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
  });

  it('tampoco lo marca si la suscripción queda incompleta a la espera de autenticación', async () => {
    const { service, updateUser } = buildService({
      subscription: activeSubscription,
      updateResult: { status: 'incomplete', id: 'sub_123' },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(BadRequestException);
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
  });

  /**
   * Una tarjeta con 3DS no puede completar el pago en la propia llamada: el
   * cambio queda en `pending_update` hasta que el cliente autentica. Con
   * error_if_incomplete Stripe devolvía un error sin PaymentIntent y esas
   * tarjetas no tenían forma alguna de completar el upgrade.
   */
  it('deja el plan intacto y da el enlace de pago cuando hace falta autenticar (3DS)', async () => {
    const { service, updateUser } = buildService({
      subscription: activeSubscription,
      updateResult: {
        status: 'active',
        id: 'sub_123',
        pending_update: { expires_at: 1234567890 },
        latest_invoice: {
          id: 'in_123',
          hosted_invoice_url: 'https://invoice.stripe.com/i/test',
        },
      },
    });

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    // El cliente necesita saber que sigue igual y adónde ir a completarlo.
    expect(error.message).toContain('has not been changed');
    expect(error.message).toContain('https://invoice.stripe.com/i/test');
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
  });

  it('si no hay enlace de factura, remite a los ajustes de la cuenta', async () => {
    const { service } = buildService({
      subscription: activeSubscription,
      updateResult: {
        status: 'active',
        id: 'sub_123',
        pending_update: { expires_at: 1234567890 },
        latest_invoice: null,
      },
    });

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error.message).toContain('has not been changed');
    expect(error.message).toContain('account settings');
  });

  /**
   * Un error de red o un 5xx de Stripe son INDETERMINADOS: el cambio puede
   * haberse aplicado y cobrado aunque la respuesta no llegara. Afirmar que el
   * plan no cambió sería falso y empujaría al cliente a reintentar sobre un
   * cargo ya hecho.
   */
  it('reconcilia un error de conexión: si el cambio sí se aplicó, lo sincroniza', async () => {
    const { service, updateUser, retrieve } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeConnectionError', message: 'network error' },
    });
    // Tres lecturas: la inicial, la revalidación dentro del mutex y la de la
    // reconciliación, que ya ve el precio nuevo — Stripe sí lo aplicó.
    retrieve
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValueOnce({
        status: 'active',
        items: { data: [{ id: 'si_123', price: { id: PROMAX_MXN } }] },
      });

    const result = await service.upgradeSubscription('uid-1', 'promax');

    expect(result.success).toBe(true);
    expect(updateUser).toHaveBeenCalledWith('uid-1', { plan: 'promax' });
  });

  it('tras un error de conexión en el que NO se aplicó, informa del fallo sin tocar el plan', async () => {
    const { service, updateUser, retrieve } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeConnectionError', message: 'network error' },
    });
    // Tercera lectura —la de la reconciliación— sigue en el precio viejo: el
    // cambio no llegó a aplicarse.
    retrieve
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValueOnce({
        status: 'active',
        items: { data: [{ id: 'si_123', price: { id: 'price_pro_mxn' } }] },
      });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow();
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
  });

  /**
   * La petición perdida pudo llegar a crear un pending update. Clasificarlo como
   * "no aplicado" devolvía un error genérico y, peor, invitaba a reintentar: un
   * update nuevo reemplaza el pending update y anula su factura, dejando al
   * cliente sin el enlace con el que ya podía pagar.
   */
  it('si el timeout dejó un pending update, devuelve su enlace en vez de un error genérico', async () => {
    const { service, updateUser, retrieve, update } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeConnectionError', message: 'timeout' },
    });
    // El pending va en la TERCERA lectura, la de la reconciliación. Si se deja
    // en la segunda lo consume la revalidación del mutex, el update nunca se
    // llama y este test pasaría sin llegar a reconciliar nada.
    retrieve
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValueOnce({
        status: 'active',
        pending_update: { expires_at: 1234567890 },
        items: { data: [{ id: 'si_123', price: { id: 'price_pro_mxn' } }] },
        latest_invoice: {
          id: 'in_pendiente',
          hosted_invoice_url: 'https://invoice.stripe.com/i/pendiente',
        },
      });

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error.message).toContain('has not been changed');
    expect(error.message).toContain('https://invoice.stripe.com/i/pendiente');
    // Sin esto, el test volvería a pasar por el camino equivocado sin avisar.
    expect(update).toHaveBeenCalled();
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
    // Sin expandir la factura no habría enlace que devolver.
    expect(retrieve).toHaveBeenLastCalledWith(
      'sub_123',
      expect.objectContaining({ expand: ['latest_invoice'] }),
    );
  });

  /**
   * La clave no puede derivarse del reloj: una cubeta por minuto parte dos
   * llamadas separadas por segundos si caen a ambos lados del cambio de minuto,
   * que es justo el caso a cubrir — el reintento inmediato tras un timeout.
   */
  it('el reintento tras un timeout reusa la clave aunque cruce el cambio de minuto', async () => {
    const { service, update, retrieve } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeConnectionError', message: 'timeout' },
    });
    // Al releer sigue sin aplicarse: el intento sigue vivo y la clave se conserva.
    retrieve.mockResolvedValue(activeSubscription);

    const reloj = jest.spyOn(Date, 'now');
    reloj.mockReturnValue(new Date('2026-08-04T12:00:59Z').getTime());
    await service.upgradeSubscription('uid-1', 'promax').catch(() => undefined);

    // Dos segundos después, pero ya en el minuto siguiente.
    reloj.mockReturnValue(new Date('2026-08-04T12:01:01Z').getTime());
    await service.upgradeSubscription('uid-1', 'promax').catch(() => undefined);

    expect(update).toHaveBeenCalledTimes(2);
    expect(claveUsada(update, 0)).toBe(claveUsada(update, 1));
    reloj.mockRestore();
  });

  /**
   * Si ya hay un cambio esperando pago, repetir el endpoint no debe lanzar otro
   * update: Stripe reemplazaría el pending update y anularía su factura, con lo
   * que el enlace que el cliente ya tenía dejaría de funcionar.
   */
  it('con un pending update en curso devuelve su factura y no toca Stripe', async () => {
    const { service, update } = buildService({
      subscription: {
        status: 'active',
        pending_update: { expires_at: 1234567890 },
        items: { data: [{ id: 'si_123' }] },
        latest_invoice: {
          id: 'in_encurso',
          hosted_invoice_url: 'https://invoice.stripe.com/i/encurso',
        },
      },
    });

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error.message).toContain('https://invoice.stripe.com/i/encurso');
    // Lo esencial: no se lanza un update que invalidaría ese enlace.
    expect(update).not.toHaveBeenCalled();
  });

  it('expande la factura al leer la suscripción, o no habría enlace que devolver', async () => {
    const { service, retrieve } = buildService({
      subscription: activeSubscription,
    });

    await service.upgradeSubscription('uid-1', 'promax');

    expect(retrieve).toHaveBeenCalledWith(
      'sub_123',
      expect.objectContaining({ expand: ['latest_invoice'] }),
    );
  });

  it('un intento nuevo tras un rechazo definitivo parte de otra clave', async () => {
    const { service, update } = buildService({
      subscription: activeSubscription,
      updateError: {
        statusCode: 402,
        type: 'StripeCardError',
        message: 'Your card was declined.',
      },
    });

    await service.upgradeSubscription('uid-1', 'promax').catch(() => undefined);
    await service.upgradeSubscription('uid-1', 'promax').catch(() => undefined);

    // Reusar la clave devolvería el error cacheado de la tarjeta vieja y el
    // reintento —ya con otra tarjeta— ni siquiera llegaría a intentarse.
    expect(claveUsada(update, 0)).not.toBe(claveUsada(update, 1));
  });

  it('si no puede releer el estado, no afirma que el plan siga igual', async () => {
    const { service, updateUser, retrieve } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeAPIError', message: 'api error' },
    });
    retrieve
      .mockResolvedValueOnce(activeSubscription)
      // Revalidación dentro del mutex; la que falla es la de la reconciliación.
      .mockResolvedValueOnce(activeSubscription)
      .mockRejectedValueOnce(new Error('still down'));

    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    // Nunca "your plan has not been changed": no se sabe, y decirlo sería mentir.
    expect(error.message).toContain('could not confirm');
    expect(escriturasDePlan(updateUser)).toHaveLength(0);
  });

  it('en un estado de cobro pide actualizar el método de pago', async () => {
    const { service, update } = buildService({
      subscription: { status: 'past_due', items: { data: [{ id: 'si_123' }] } },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(/past_due.*payment method/s);
    expect(update).not.toHaveBeenCalled();
  });

  it('en una suscripción terminada pide volver a contratar, no cambiar la tarjeta', async () => {
    const { service } = buildService({
      subscription: { status: 'canceled', items: { data: [{ id: 'si_123' }] } },
    });

    // Pasa cuando el webhook de cancelación no llegó y Firestore conserva el
    // subscriptionId: la tarjeta del cliente está bien, no hay nada que cambiar ahí.
    const error = await service
      .upgradeSubscription('uid-1', 'promax')
      .catch((e: Error) => e);

    expect(error.message).toContain('canceled');
    expect(error.message).toContain('subscribe again');
    expect(error.message).not.toContain('payment method');
  });

  it('rechaza un cambio que no es una subida de plan', async () => {
    const { service, update } = buildService({
      subscription: activeSubscription,
    });

    // El usuario ya está en pro: pro → pro no es upgrade.
    await expect(service.upgradeSubscription('uid-1', 'pro')).rejects.toThrow(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * `always_invoice` emite y cobra la factura de la proración dentro del propio
   * update, y Stripe congela en ella los datos fiscales al finalizarla. Si la
   * propagación no ocurre antes, esa factura sale con datos viejos o sin ellos y
   * ya no hay forma de corregirla.
   */
  describe('sincronización fiscal previa', () => {
    it('propaga el perfil fiscal antes de tocar la suscripción', async () => {
      const { service, update, syncTaxProfileToStripe } = buildService({
        subscription: {
          id: 'sub_123',
          status: 'active',
          items: { data: [{ id: 'si_1', price: { id: 'price_pro_mxn' } }] },
        },
      });

      await service.upgradeSubscription('uid-1', 'promax');

      expect(syncTaxProfileToStripe).toHaveBeenCalledWith('uid-1', {
        throwOnError: true,
      });
      // El orden importa: después del update ya no sirve de nada.
      expect(syncTaxProfileToStripe.mock.invocationCallOrder[0]).toBeLessThan(
        update.mock.invocationCallOrder[0],
      );
    });

    it('aborta el upgrade si la sincronización falla', async () => {
      const { service, update } = buildService({
        subscription: {
          id: 'sub_123',
          status: 'active',
          items: { data: [{ id: 'si_1', price: { id: 'price_pro_mxn' } }] },
        },
        syncTaxProfileToStripe: jest
          .fn()
          .mockRejectedValue(new Error('Stripe caído')),
      });

      await expect(
        service.upgradeSubscription('uid-1', 'promax'),
      ).rejects.toThrow(ServiceUnavailableException);
      // Sin cobro no hay factura con datos fiscales congelados que corregir.
      expect(update).not.toHaveBeenCalled();
    });
  });

  /**
   * El webhook escribe por el mismo camino. Sin un reloj común, una lectura de
   * Stripe anterior a este cambio podría aterrizar después y revertir el plan
   * recién pagado (issue #74).
   */
  it('sella la escritura del plan con el instante de la confirmación', async () => {
    const { service, update, updateUserSubscriptionState } = buildService({
      subscription: activeSubscription,
    });

    const antes = Date.now();
    await service.upgradeSubscription('uid-1', 'promax');

    expect(updateUserSubscriptionState).toHaveBeenCalledWith(
      'uid-1',
      { plan: 'promax' },
      expect.any(Date),
      // Fencing token: si este ciclo se demoró más que el lease y otro lo
      // relevó, la escritura se descarta en la propia transacción.
      'sync-tok',
    );
    // Posterior a la respuesta de Stripe: el dato no es válido antes de que
    // Stripe lo devolviera.
    const readAt: Date = updateUserSubscriptionState.mock.calls[0][2];
    expect(readAt.getTime()).toBeGreaterThanOrEqual(antes);
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      updateUserSubscriptionState.mock.invocationCallOrder[0],
    );
  });
});

/**
 * Stripe no garantiza el orden de entrega de los webhooks. El flujo de upgrade
 * con `pending_if_incomplete` emite dos `customer.subscription.updated` —uno con
 * el precio anterior al quedar pendiente el cobro, otro con el nuevo al
 * confirmarse—, así que un evento tardío puede degradar un plan ya pagado
 * (issue #74).
 */
describe('PaymentsService — handleSubscriptionUpdated', () => {
  const PRO_MXN = 'price_pro_mxn';
  const PROMAX_MXN = 'price_promax_mxn';

  function subscriptionCon(
    priceId: string,
    status = 'active',
  ): Record<string, unknown> {
    return {
      id: 'sub_123',
      status,
      customer: 'cus_123',
      items: { data: [{ id: 'si_1', price: { id: priceId } }] },
    };
  }

  function buildService(overrides: {
    /** Estado vigente que devuelve Stripe al releer. */
    current?: unknown;
    retrieveError?: unknown;
    /** `false` simula que otra escritura más fresca ya ganó. */
    aplicada?: boolean;
    user?: Record<string, unknown>;
    /** `null` simula que otro ciclo tiene el lock tomado. */
    lockToken?: string | null;
    releaseError?: unknown;
  }) {
    const retrieve = overrides.retrieveError
      ? jest.fn().mockRejectedValue(overrides.retrieveError)
      : jest.fn().mockResolvedValue(overrides.current);

    const acquireSubscriptionSyncLock = jest
      .fn()
      .mockResolvedValue(
        overrides.lockToken === undefined ? 'tok-1' : overrides.lockToken,
      );
    const releaseSubscriptionSyncLock = overrides.releaseError
      ? jest.fn().mockRejectedValue(overrides.releaseError)
      : jest.fn().mockResolvedValue(undefined);

    const updateUserSubscriptionState = jest
      .fn()
      .mockResolvedValue(overrides.aplicada ?? true);
    const getUserByStripeCustomerId = jest.fn().mockResolvedValue(
      overrides.user ?? {
        id: 'uid-1',
        email: 'cliente@example.com',
        plan: 'promax',
        country: 'MX',
        stripeSubscriptionId: 'sub_123',
      },
    );
    const queueSubscriptionDowngradedEmail = jest
      .fn()
      .mockResolvedValue(undefined);

    const service: any = Object.create(PaymentsService.prototype);
    service.stripe = { subscriptions: { retrieve } };
    service.firestoreService = {
      getUserByStripeCustomerId,
      updateUserSubscriptionState,
      acquireSubscriptionSyncLock,
      releaseSubscriptionSyncLock,
    };
    service.emailService = { queueSubscriptionDowngradedEmail };
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    // Class field: `Object.create` no lo materializa y `withRetry` lo necesita.
    service.MAX_RETRIES = 3;
    service.proPriceIdMxn = PRO_MXN;
    service.promaxPriceIdMxn = PROMAX_MXN;

    return {
      service,
      retrieve,
      updateUserSubscriptionState,
      queueSubscriptionDowngradedEmail,
      acquireSubscriptionSyncLock,
      releaseSubscriptionSyncLock,
    };
  }

  it('aplica el estado vigente en Stripe, no el del evento tardío', async () => {
    // El evento trae el precio anterior (PRO); Stripe ya tiene PROMAX pagado.
    const { service, updateUserSubscriptionState } = buildService({
      current: subscriptionCon(PROMAX_MXN),
    });

    await service.handleSubscriptionUpdated(subscriptionCon(PRO_MXN));

    expect(updateUserSubscriptionState).toHaveBeenCalledWith(
      'uid-1',
      expect.objectContaining({ plan: 'promax' }),
      expect.any(Date),
      'tok-1',
    );
  });

  it('relee de Stripe antes de escribir', async () => {
    const { service, retrieve, updateUserSubscriptionState } = buildService({
      current: subscriptionCon(PROMAX_MXN),
    });

    await service.handleSubscriptionUpdated(subscriptionCon(PROMAX_MXN));

    expect(retrieve).toHaveBeenCalledWith('sub_123');
    expect(retrieve.mock.invocationCallOrder[0]).toBeLessThan(
      updateUserSubscriptionState.mock.invocationCallOrder[0],
    );
    // El sello es anterior a la lectura: cualquier escritura sellada después
    // describe un estado más fresco y debe ganar.
    const readAt: Date = updateUserSubscriptionState.mock.calls[0][2];
    expect(readAt).toBeInstanceOf(Date);
  });

  it('propaga el fallo de la relectura para que Stripe reintente el webhook', async () => {
    const { service, updateUserSubscriptionState } = buildService({
      retrieveError: Object.assign(new Error('Stripe caído'), {
        type: 'StripeConnectionError',
      }),
    });

    await expect(
      service.handleSubscriptionUpdated(subscriptionCon(PRO_MXN)),
    ).rejects.toThrow('Stripe caído');
    // Escribir el snapshot sin confirmarlo sería justo el bug que esto corrige.
    expect(updateUserSubscriptionState).not.toHaveBeenCalled();
  });

  it('no escribe nada si Stripe no reconoce la suscripción', async () => {
    // `resource_missing` es un ID inválido o inexistente —entorno cruzado, clave
    // sin permisos—, no la prueba de que la suscripción terminara: las
    // canceladas siguen siendo recuperables. Aceptar el snapshot lo sellaría
    // como vigente y, si viniera `active`, restauraría un plan de pago.
    const { service, updateUserSubscriptionState } = buildService({
      retrieveError: Object.assign(new Error('No such subscription'), {
        code: 'resource_missing',
      }),
    });

    await expect(
      service.handleSubscriptionUpdated(subscriptionCon(PROMAX_MXN, 'active')),
    ).rejects.toThrow('No such subscription');
    expect(updateUserSubscriptionState).not.toHaveBeenCalled();
  });

  it('no avisa de la degradación si la escritura se descartó por obsoleta', async () => {
    const { service, queueSubscriptionDowngradedEmail } = buildService({
      current: subscriptionCon(PRO_MXN, 'canceled'),
      aplicada: false,
    });

    await service.handleSubscriptionUpdated(
      subscriptionCon(PRO_MXN, 'canceled'),
    );

    // Alarmaría a un cliente que sigue de pago.
    expect(queueSubscriptionDowngradedEmail).not.toHaveBeenCalled();
  });

  it('avisa de la degradación cuando la escritura sí se aplica', async () => {
    const { service, queueSubscriptionDowngradedEmail } = buildService({
      current: subscriptionCon(PRO_MXN, 'canceled'),
    });

    await service.handleSubscriptionUpdated(
      subscriptionCon(PRO_MXN, 'canceled'),
    );

    expect(queueSubscriptionDowngradedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'uid-1' }),
      'promax',
      'canceled',
    );
  });

  /**
   * Defensa en profundidad. El lock por usuario (issue #77) impide que dos
   * ciclos se solapen, así que esta carrera ya no debería darse en producción;
   * el sello sigue cubriendo los ciclos que mueran con el lease tomado, y debe
   * representar el estado OBSERVADO y no el momento en que salió la petición.
   * Sellar al inicio invertía la garantía: una relectura lenta que acaba viendo
   * el plan nuevo llevaría un sello menor que otra posterior que vio el viejo.
   *
   * Por eso este test concede el lock a los dos ciclos: verifica la capa de
   * abajo, no la serialización.
   */
  it('gana la relectura que observó el estado más reciente aunque su petición saliera antes', async () => {
    const espera = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    let resolverLenta: (value: unknown) => void;
    let resolverRapida: (value: unknown) => void;
    const retrieve = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolverLenta = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolverRapida = resolve)),
      );

    // Guarda de versión real sobre un documento con estado, para comprobar el
    // desenlace observable —qué plan queda— y no solo el orden de los sellos.
    const doc: Record<string, unknown> = { plan: 'pro' };
    const updateUserSubscriptionState = jest
      .fn()
      .mockImplementation(
        async (_id: string, data: Record<string, unknown>, readAt: Date) => {
          const stored = doc.subscriptionSyncedAt as string | undefined;
          const storedMs = stored ? new Date(stored).getTime() : NaN;
          if (Number.isFinite(storedMs) && storedMs > readAt.getTime()) {
            return false;
          }
          Object.assign(doc, data, {
            subscriptionSyncedAt: readAt.toISOString(),
          });
          return true;
        },
      );

    const service: any = Object.create(PaymentsService.prototype);
    service.stripe = { subscriptions: { retrieve } };
    service.firestoreService = {
      getUserByStripeCustomerId: jest
        .fn()
        .mockResolvedValue({ id: 'uid-1', plan: 'pro', country: 'MX' }),
      updateUserSubscriptionState,
      // Lock permisivo a propósito: aquí se ejercita el sello, no el lock.
      acquireSubscriptionSyncLock: jest.fn().mockResolvedValue('tok'),
      releaseSubscriptionSyncLock: jest.fn().mockResolvedValue(undefined),
    };
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.MAX_RETRIES = 3;
    service.proPriceIdMxn = PRO_MXN;
    service.promaxPriceIdMxn = PROMAX_MXN;

    // La lenta sale primero; la rápida, unos milisegundos después.
    const lenta = service.handleSubscriptionUpdated(subscriptionCon(PRO_MXN));
    await espera(10);
    const rapida = service.handleSubscriptionUpdated(subscriptionCon(PRO_MXN));
    // Ceder hasta que ambas hayan pasado por `retrieve`: antes hay un await
    // —la búsqueda del usuario— y sin esto la segunda aún no lo habría llamado.
    await espera(10);

    // Se resuelven en orden inverso: la rápida observa el estado viejo...
    resolverRapida(subscriptionCon(PRO_MXN));
    await rapida;
    await espera(10);
    // ...y la lenta, que salió antes, observa el plan ya pagado.
    resolverLenta(subscriptionCon(PROMAX_MXN));
    await lenta;

    // Con el sello tomado al inicio, esta escritura se habría descartado por
    // llevar un sello menor y el cliente se quedaba en PRO habiendo pagado.
    expect(doc.plan).toBe('promax');
  });

  /**
   * El sello ordena por la llegada de la respuesta a Cloud Run, no por cuándo
   * Stripe observó el estado, y entre ambos instantes cabe una red lenta. La
   * salida es no solapar los ciclos (issue #77).
   */
  it('no relee ni escribe si otro ciclo tiene el lock del usuario', async () => {
    const { service, retrieve, updateUserSubscriptionState } = buildService({
      current: subscriptionCon(PROMAX_MXN),
      lockToken: null,
    });

    // Lanza para que Stripe reentregue: esperar aquí agotaría el plazo de
    // respuesta del webhook y Stripe lo reintentaría igualmente.
    await expect(
      service.handleSubscriptionUpdated(subscriptionCon(PRO_MXN)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(retrieve).not.toHaveBeenCalled();
    expect(updateUserSubscriptionState).not.toHaveBeenCalled();
  });

  it('libera el lock al terminar', async () => {
    const { service, releaseSubscriptionSyncLock } = buildService({
      current: subscriptionCon(PROMAX_MXN),
    });

    await service.handleSubscriptionUpdated(subscriptionCon(PROMAX_MXN));

    expect(releaseSubscriptionSyncLock).toHaveBeenCalledWith('uid-1', 'tok-1');
  });

  it('libera el lock aunque el ciclo falle a mitad', async () => {
    // Sin el `finally`, una relectura fallida dejaría al usuario sin sincronizar
    // hasta que caducara el lease.
    const { service, releaseSubscriptionSyncLock } = buildService({
      retrieveError: new Error('Stripe caído'),
    });

    await expect(
      service.handleSubscriptionUpdated(subscriptionCon(PRO_MXN)),
    ).rejects.toThrow('Stripe caído');
    expect(releaseSubscriptionSyncLock).toHaveBeenCalledWith('uid-1', 'tok-1');
  });

  it('no convierte un fallo al liberar el lock en un fallo del webhook', async () => {
    // El lease caduca solo; provocar una reentrega de algo ya aplicado sería
    // peor que dejarlo expirar.
    const { service, updateUserSubscriptionState } = buildService({
      current: subscriptionCon(PROMAX_MXN),
      releaseError: new Error('Firestore caído'),
    });

    await expect(
      service.handleSubscriptionUpdated(subscriptionCon(PROMAX_MXN)),
    ).resolves.toBeUndefined();
    expect(updateUserSubscriptionState).toHaveBeenCalled();
  });

  it('no toca el plan si el precio vigente no mapea a ninguno', async () => {
    const { service, updateUserSubscriptionState } = buildService({
      current: subscriptionCon('price_desconocido'),
    });

    await service.handleSubscriptionUpdated(subscriptionCon(PROMAX_MXN));

    expect(updateUserSubscriptionState).not.toHaveBeenCalled();
  });
});
