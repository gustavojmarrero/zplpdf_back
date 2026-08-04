// Evitar la conexión real a Stripe al cargar el módulo.
jest.mock('stripe', () => jest.fn());

import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';

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
  }) {
    const retrieve = overrides.retrieveError
      ? jest.fn().mockRejectedValue(overrides.retrieveError)
      : jest.fn().mockResolvedValue(overrides.subscription);
    const update = overrides.updateError
      ? jest.fn().mockRejectedValue(overrides.updateError)
      : jest.fn().mockResolvedValue({});
    const updateUser = jest.fn().mockResolvedValue(undefined);

    const service: any = Object.create(PaymentsService.prototype);
    service.stripe = { subscriptions: { retrieve, update } };
    service.firestoreService = {
      getUserById: jest.fn().mockResolvedValue({
        id: 'uid-1',
        plan: 'pro',
        country: 'MX',
        stripeSubscriptionId: 'sub_123',
      }),
      updateUser,
    };
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.promaxPriceIdMxn = PROMAX_MXN;

    return { service, retrieve, update, updateUser };
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
      }),
    );
    expect(updateUser).toHaveBeenCalledWith('uid-1', { plan: 'promax' });
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
    expect(updateUser).not.toHaveBeenCalled();
    // El log debe ser CRITICAL y nombrar la env var, para que sea accionable.
    expect(service.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL'),
    );
    expect(service.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('STRIPE_SECRET_KEY'),
    );
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
    const { service } = buildService({
      subscription: activeSubscription,
      updateError: {
        statusCode: 402,
        type: 'StripeCardError',
        message: 'Your card was declined.',
      },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(BadRequestException);
  });

  it('indica el estado real cuando la suscripción no está activa', async () => {
    const { service, update } = buildService({
      subscription: { status: 'past_due', items: { data: [{ id: 'si_123' }] } },
    });

    await expect(
      service.upgradeSubscription('uid-1', 'promax'),
    ).rejects.toThrow(/past_due/);
    expect(update).not.toHaveBeenCalled();
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
