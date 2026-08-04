// Evitar la conexión real a Stripe al cargar el módulo.
jest.mock('stripe', () => jest.fn());

import {
  BadRequestException,
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
     * Reproduce la semántica transaccional real: reutiliza la clave vigente y,
     * si no la hay, persiste la candidata. El TTL se evalúa sobre el valor
     * almacenado tal cual, para que un `createdAt` mal serializado se note.
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
      ) => {
        const stored = userDoc.upgradeIdempotency as
          | Record<string, any>
          | null
          | undefined;
        const createdAtMs = stored?.createdAt
          ? new Date(stored.createdAt?.toDate?.() ?? stored.createdAt).getTime()
          : NaN;
        const vigente =
          !!stored?.key &&
          stored.targetPlan === candidate.targetPlan &&
          stored.subscriptionId === candidate.subscriptionId &&
          Number.isFinite(createdAtMs) &&
          Date.now() - createdAtMs < ttlMs;

        if (vigente) {
          return stored.key;
        }
        userDoc.upgradeIdempotency = {
          ...candidate,
          createdAt: new Date().toISOString(),
        };
        return candidate.key;
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

    const service: any = Object.create(PaymentsService.prototype);
    service.stripe = { subscriptions: { retrieve, update } };
    service.firestoreService = {
      getUserById,
      updateUser,
      acquireUpgradeIdempotency,
      releaseUpgradeIdempotency,
    };
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.promaxPriceIdMxn = PROMAX_MXN;

    return {
      service,
      retrieve,
      update,
      updateUser,
      getUserById,
      userDoc,
      acquireUpgradeIdempotency,
      releaseUpgradeIdempotency,
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

  const activeSubscription = {
    status: 'active',
    items: { data: [{ id: 'si_123' }] },
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
      expect.any(Number),
    );
    // La clave no se decide a partir del usuario leído antes de la transacción.
    expect(getUserById).toHaveBeenCalledTimes(1);
  });

  it('dos upgrades concurrentes comparten clave y no duplican la mutación', async () => {
    const { service, update } = buildService({
      subscription: activeSubscription,
    });

    await Promise.all([
      service.upgradeSubscription('uid-1', 'promax'),
      service.upgradeSubscription('uid-1', 'promax'),
    ]);

    // Misma clave ⇒ Stripe deduplica y solo se cobra una vez.
    expect(claveUsada(update, 0)).toBe(claveUsada(update, 1));
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
    // Al releer, la suscripción ya está en el precio nuevo: Stripe sí lo aplicó.
    retrieve.mockResolvedValueOnce(activeSubscription).mockResolvedValueOnce({
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
    // Al releer sigue en el precio viejo: el cambio no llegó a aplicarse.
    retrieve.mockResolvedValueOnce(activeSubscription).mockResolvedValueOnce({
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
    const { service, updateUser, retrieve } = buildService({
      subscription: activeSubscription,
      updateError: { type: 'StripeConnectionError', message: 'timeout' },
    });
    retrieve.mockResolvedValueOnce(activeSubscription).mockResolvedValueOnce({
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
});
