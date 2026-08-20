// Evitar que el constructor real de Stripe intente validar la clave de test.
jest.mock('stripe', () => jest.fn());

import { HttpException } from '@nestjs/common';
import { AccountDeletionService } from './account-deletion.service.js';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import { RETENTION_REASON_FISCAL } from './dto/delete-account.dto.js';
import type { User } from '../../common/interfaces/user.interface.js';

/** URL firmada con el formato real, para que se le pueda extraer el path. */
function signedUrl(file: string): string {
  return `https://storage.googleapis.com/bucket-zpl/${file}?X-Goog-Algorithm=GOOG4-RSA-SHA256`;
}

function historyRecord(id: string) {
  return {
    id,
    userId: 'uid-1',
    jobId: `job-${id}`,
    labelCount: 5,
    labelSize: '4x6',
    status: 'completed' as const,
    outputFormat: 'pdf' as const,
    fileUrl: signedUrl(`label-${id}.pdf`),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

const baseUser: User = {
  id: 'uid-1',
  email: 'user@example.com',
  emailVerified: true,
  plan: 'pro',
  role: 'user',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
} as User;

/**
 * El servicio tiene un constructor que abre un cliente de Stripe real. Se
 * instancia por prototipo e inyectan solo las dependencias que cada test
 * ejercita, como en el resto de specs de este módulo.
 */
function buildService(
  overrides: {
    user?: User | null;
    history?: ReturnType<typeof historyRecord>[][];
    stripe?: Record<string, any> | null;
    firestore?: Record<string, jest.Mock>;
    storage?: Record<string, jest.Mock>;
  } = {},
) {
  const history = overrides.history ?? [
    [historyRecord('h1'), historyRecord('h2')],
  ];
  let page = 0;

  const firestore = {
    getUserById: jest
      .fn()
      .mockResolvedValue(
        overrides.user === undefined ? baseUser : overrides.user,
      ),
    scanUserConversionHistory: jest
      .fn()
      .mockImplementation(async () => history[page++] ?? []),
    deleteConversionHistoryByIds: jest
      .fn()
      .mockImplementation(async (ids: string[]) => ids.length),
    deleteZplDebugFilesByUserId: jest.fn().mockResolvedValue(0),
    getBatchIdsByUserId: jest.fn().mockResolvedValue([]),
    deleteBatchJobsByIds: jest.fn().mockResolvedValue(0),
    anonymizeUserActivityRecords: jest.fn().mockResolvedValue(0),
    deleteConversionStatusesByUserId: jest.fn().mockResolvedValue(0),
    anonymizeUserFinancialRecords: jest.fn().mockResolvedValue(0),
    deleteUsageByUserId: jest.fn().mockResolvedValue(2),
    deleteTaxProfile: jest.fn().mockResolvedValue(true),
    anonymizeUserCfdis: jest.fn().mockResolvedValue(3),
    cancelPendingEmails: jest.fn().mockResolvedValue(0),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    ...overrides.firestore,
  };

  const storage = {
    deleteFile: jest.fn().mockResolvedValue(true),
    deleteByPrefix: jest.fn().mockResolvedValue(1),
    ...overrides.storage,
  };

  const firebaseAdmin = { deleteUser: jest.fn().mockResolvedValue(undefined) };

  const stripe =
    overrides.stripe === null
      ? null
      : {
          subscriptions: {
            retrieve: jest.fn().mockResolvedValue({
              id: 'sub_1',
              status: 'active',
            }),
            list: jest.fn().mockResolvedValue({ data: [] }),
            cancel: jest.fn().mockResolvedValue({
              id: 'sub_1',
              status: 'canceled',
              canceled_at: Math.floor(
                new Date('2026-08-19T10:00:00.000Z').getTime() / 1000,
              ),
            }),
          },
          invoices: {
            list: jest.fn().mockResolvedValue({
              data: [{ id: 'in_1' }, { id: 'in_2' }],
              has_more: false,
            }),
          },
          customers: {
            retrieve: jest.fn().mockResolvedValue({
              id: 'cus_1',
              metadata: { userId: 'uid-1' },
            }),
            update: jest.fn().mockResolvedValue({}),
            listTaxIds: jest.fn().mockResolvedValue({ data: [] }),
            deleteTaxId: jest.fn().mockResolvedValue({}),
          },
          ...overrides.stripe,
        };

  const service: any = Object.create(AccountDeletionService.prototype);
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  service.firestoreService = firestore;
  service.firebaseAdminService = firebaseAdmin;
  service.storageService = storage;
  service.stripe = stripe;

  return { service, firestore, storage, firebaseAdmin, stripe };
}

describe('AccountDeletionService — baja completa', () => {
  it('cancela la suscripción, borra los datos y devuelve el contrato del frontend', async () => {
    const { service, firestore, storage, firebaseAdmin, stripe } =
      buildService();

    const result = await service.deleteAccount('uid-1');

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1');
    expect(result).toEqual({
      deleted: {
        conversions: 2,
        // Dos PDF del historial más el ZPL original borrado por prefijo.
        storedFiles: 3,
        taxProfile: true,
        subscription: {
          cancelled: true,
          plan: 'pro',
          effectiveAt: '2026-08-19T10:00:00.000Z',
        },
      },
      retained: {
        invoices: 2,
        reason: RETENTION_REASON_FISCAL,
      },
    });

    expect(storage.deleteFile).toHaveBeenCalledWith('label-h1.pdf');
    expect(storage.deleteByPrefix).toHaveBeenCalledWith('debug-zpl/uid-1/');
    expect(firestore.deleteUsageByUserId).toHaveBeenCalledWith('uid-1');
    expect(firestore.deleteUser).toHaveBeenCalledWith('uid-1');
    expect(firebaseAdmin.deleteUser).toHaveBeenCalledWith('uid-1');
  });

  it('borra los batches del usuario y los ZIP que cuelgan de ellos', async () => {
    const { service, firestore, storage } = buildService({
      firestore: {
        getBatchIdsByUserId: jest
          .fn()
          .mockResolvedValue(['batch-1', 'batch-2']),
      },
      storage: {
        deleteFile: jest.fn().mockResolvedValue(true),
        deleteByPrefix: jest.fn().mockResolvedValue(2),
      },
    });

    const result = await service.deleteAccount('uid-1');

    expect(storage.deleteByPrefix).toHaveBeenCalledWith('batches/batch-1/');
    expect(storage.deleteByPrefix).toHaveBeenCalledWith('batches/batch-2/');
    // Los documentos se borran DESPUÉS de sus archivos, y solo los limpiados.
    expect(firestore.deleteBatchJobsByIds).toHaveBeenCalledWith([
      'batch-1',
      'batch-2',
    ]);
    // El doc de estado sirve `GET /zpl/status/:jobId` con la URL del resultado.
    expect(firestore.deleteConversionStatusesByUserId).toHaveBeenCalledWith(
      'uid-1',
    );
    // 2 PDF del historial + 3 prefijos (debug-zpl y los dos batches) x 2.
    expect(result.deleted.storedFiles).toBe(8);
  });

  it('anonimiza también los registros contables locales', async () => {
    const { service, firestore } = buildService();

    await service.deleteAccount('uid-1');

    // stripe_transactions y subscription_events llevan userId y userEmail: se
    // conservan por contabilidad, pero dejan de nombrar al titular.
    expect(firestore.anonymizeUserFinancialRecords).toHaveBeenCalledWith(
      'uid-1',
    );
  });

  it('no da por buena la baja si el customer de Stripe se queda sin anonimizar', async () => {
    const { service, firestore, stripe } = buildService();
    stripe.customers.update.mockRejectedValue(new Error('stripe caído'));

    const error: HttpException = await service
      .deleteAccount('uid-1')
      .catch((e: HttpException) => e);

    // El customer conservaría nombre, email y domicilio: responder 200
    // afirmaría lo contrario de lo que pasó.
    const response = error.getResponse() as any;
    expect(response.error).toBe(ErrorCodes.ACCOUNT_DELETION_PARTIAL);
    expect(response.data.failedSteps).toContain('retainedRecords');
    expect(firestore.deleteUser).not.toHaveBeenCalled();
  });

  it('borra el domicilio y los tax IDs del customer, no solo su email', async () => {
    const { service, stripe } = buildService();
    stripe.customers.listTaxIds.mockResolvedValue({
      data: [{ id: 'txi_1' }, { id: 'txi_2' }],
    });

    await service.deleteAccount('uid-1');

    expect(stripe.customers.update).toHaveBeenCalledWith(
      'cus_1',
      expect.objectContaining({ address: null, phone: '' }),
    );
    expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith('cus_1', 'txi_1');
    expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith('cus_1', 'txi_2');
  });

  it('anonimiza la cola de emails, sus eventos y el feedback', async () => {
    const { service, firestore } = buildService();

    await service.deleteAccount('uid-1');

    expect(firestore.anonymizeUserActivityRecords).toHaveBeenCalledWith(
      'uid-1',
    );
    // Segundo pase tras borrar el perfil: cierra la ventana en la que el
    // webhook de Stripe pudo reescribir el email del titular.
    expect(firestore.anonymizeUserFinancialRecords).toHaveBeenCalledTimes(2);
  });

  it('cancela una suscripción activa que el perfil no tenía registrada', async () => {
    const { service, stripe } = buildService({
      user: { ...baseUser, stripeSubscriptionId: undefined },
    });
    stripe.subscriptions.list.mockResolvedValue({
      data: [{ id: 'sub_huerfana', status: 'active' }],
    });

    const result = await service.deleteAccount('uid-1');

    // Sin esta búsqueda por customer, la cuenta se borraría y Stripe seguiría
    // cobrando una suscripción que nadie puede cancelar ya.
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_huerfana');
    expect(result.deleted.subscription.cancelled).toBe(true);
  });

  it('conserva la fila del historial cuyo archivo no se pudo borrar', async () => {
    const { service, firestore } = buildService({
      storage: {
        deleteFile: jest.fn().mockRejectedValue({ code: 403 }),
        deleteByPrefix: jest.fn().mockResolvedValue(0),
      },
    });

    const error: HttpException = await service
      .deleteAccount('uid-1')
      .catch((e: HttpException) => e);

    // La `fileUrl` de la fila es la única pista para reintentar el borrado del
    // objeto: si se fuera la fila, el archivo quedaría en el bucket sin rastro.
    expect(firestore.deleteConversionHistoryByIds).toHaveBeenCalledWith([]);
    const response = error.getResponse() as any;
    expect(response.data.failedSteps).toContain('storedFiles');
    expect(response.data.accountDeleted).toBe(false);
  });

  it('anonimiza los CFDI en lugar de borrarlos, y anonimiza el customer de Stripe', async () => {
    const { service, firestore, stripe } = buildService();

    await service.deleteAccount('uid-1');

    expect(firestore.anonymizeUserCfdis).toHaveBeenCalledWith('uid-1');
    expect(stripe.customers.update).toHaveBeenCalledWith(
      'cus_1',
      expect.objectContaining({
        name: 'Deleted account',
        email: '',
        // La metadata previa se vacía clave a clave: Stripe fusiona en vez de
        // reemplazar, y dejar `userId` ahí reidentificaría al titular.
        metadata: expect.objectContaining({
          userId: '',
          account_deleted: 'true',
        }),
      }),
    );
  });

  it('no cuenta como archivo borrado el PDF que ya había caducado', async () => {
    const { service } = buildService({
      storage: { deleteFile: jest.fn().mockResolvedValue(false) },
    });

    const result = await service.deleteAccount('uid-1');

    // Solo el prefijo de ZPL: los dos PDF del historial ya no existían.
    expect(result.deleted.storedFiles).toBe(1);
    expect(result.deleted.conversions).toBe(2);
  });

  it('recorre todas las páginas del historial', async () => {
    const bigPage = Array.from({ length: 500 }, (_, i) =>
      historyRecord(`h${i}`),
    );
    const { service } = buildService({
      history: [bigPage, [historyRecord('last')]],
    });

    const result = await service.deleteAccount('uid-1');

    expect(result.deleted.conversions).toBe(501);
  });

  it('informa de que no había suscripción sin dejar de borrar el resto', async () => {
    const { service, firestore } = buildService({
      user: { ...baseUser, stripeSubscriptionId: undefined },
    });

    const result = await service.deleteAccount('uid-1');

    expect(result.deleted.subscription).toEqual({
      cancelled: false,
      plan: null,
      effectiveAt: null,
    });
    expect(firestore.deleteUser).toHaveBeenCalled();
  });

  it('no vuelve a cancelar una suscripción que Stripe ya tenía cancelada', async () => {
    const { service, stripe } = buildService();
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'canceled',
    });

    const result = await service.deleteAccount('uid-1');

    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(result.deleted.subscription.cancelled).toBe(false);
  });

  it('devuelve 404 con USER_NOT_FOUND si no hay perfil que borrar', async () => {
    const { service, firestore } = buildService({ user: null });

    await expect(service.deleteAccount('uid-1')).rejects.toMatchObject({
      status: 404,
      response: { error: ErrorCodes.USER_NOT_FOUND },
    });
    expect(firestore.deleteUser).not.toHaveBeenCalled();
  });
});

describe('AccountDeletionService — Stripe rechaza cancelar', () => {
  it('responde SUBSCRIPTION_CANCEL_FAILED y no borra absolutamente nada', async () => {
    const { service, firestore, storage, firebaseAdmin, stripe } =
      buildService();
    stripe.subscriptions.cancel.mockRejectedValue(
      Object.assign(new Error('card_declined'), { code: 'api_error' }),
    );

    const error: HttpException = await service
      .deleteAccount('uid-1')
      .catch((e: HttpException) => e);

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      error: ErrorCodes.SUBSCRIPTION_CANCEL_FAILED,
      data: { plan: 'pro', subscriptionId: 'sub_1', reason: 'api_error' },
    });

    // La garantía del contrato: la cuenta queda intacta y se puede reintentar.
    expect(firestore.deleteConversionHistoryByIds).not.toHaveBeenCalled();
    expect(firestore.deleteUsageByUserId).not.toHaveBeenCalled();
    expect(firestore.deleteTaxProfile).not.toHaveBeenCalled();
    expect(firestore.anonymizeUserCfdis).not.toHaveBeenCalled();
    expect(firestore.deleteUser).not.toHaveBeenCalled();
    expect(firebaseAdmin.deleteUser).not.toHaveBeenCalled();
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });

  it('no borra la cuenta si hay suscripción registrada y Stripe no está configurado', async () => {
    const { service, firestore } = buildService({ stripe: null });

    const error: HttpException = await service
      .deleteAccount('uid-1')
      .catch((e: HttpException) => e);

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      error: ErrorCodes.SUBSCRIPTION_CANCEL_FAILED,
      data: { reason: 'stripe_not_configured' },
    });
    expect(firestore.deleteUser).not.toHaveBeenCalled();
  });
});

describe('AccountDeletionService — borrado parcial', () => {
  it('marca la cuenta como NO borrada cuando falla el borrado en Firestore', async () => {
    const { service } = buildService({
      firestore: {
        deleteUser: jest.fn().mockRejectedValue(new Error('firestore caído')),
      },
    });

    const error: HttpException = await service
      .deleteAccount('uid-1')
      .catch((e: HttpException) => e);

    expect(error.getStatus()).toBe(500);
    const response = error.getResponse() as any;
    expect(response.error).toBe(ErrorCodes.ACCOUNT_DELETION_PARTIAL);
    expect(response.data.accountDeleted).toBe(false);
    expect(response.data.failedSteps).toEqual(['account']);
    // La suscripción sí se canceló: el frontend necesita poder decirlo.
    expect(response.data.deleted.subscription.cancelled).toBe(true);
  });

  it('no borra la cuenta de Auth si el perfil no llegó a borrarse', async () => {
    const { service, firebaseAdmin } = buildService({
      firestore: {
        deleteUser: jest.fn().mockRejectedValue(new Error('firestore caído')),
      },
    });

    await service.deleteAccount('uid-1').catch(() => undefined);

    // Sin cuenta de Auth el usuario no podría autenticarse para reintentar la
    // baja, y quedaría un documento huérfano en Firestore.
    expect(firebaseAdmin.deleteUser).not.toHaveBeenCalled();
  });

  it('declara la cuenta viva si Firebase Auth no la borra, aunque el perfil sí se fuera', async () => {
    const { service } = buildService();
    (service.firebaseAdminService.deleteUser as jest.Mock).mockRejectedValue(
      new Error('auth caído'),
    );

    const error: HttpException = await service
      .deleteAccount('uid-1')
      .catch((e: HttpException) => e);

    const response = error.getResponse() as any;
    expect(response.data.failedSteps).toEqual(['auth']);
    // Con la cuenta de Auth viva el usuario puede volver a entrar y el perfil se
    // recrearía: afirmar que ya no existe sería falso.
    expect(response.data.accountDeleted).toBe(false);
  });

  it('no borra la identidad si quedó un paso intermedio pendiente', async () => {
    const { service, firestore, firebaseAdmin } = buildService({
      firestore: {
        deleteTaxProfile: jest.fn().mockRejectedValue(new Error('boom')),
      },
    });

    const error: HttpException = await service
      .deleteAccount('uid-1')
      .catch((e: HttpException) => e);

    const response = error.getResponse() as any;
    expect(response.data.failedSteps).toEqual(['taxProfile']);
    // El perfil fiscal seguiría ahí: borrar la cuenta lo dejaría sin dueño y al
    // usuario sin credenciales para reintentar la baja.
    expect(response.data.accountDeleted).toBe(false);
    expect(firestore.deleteUser).not.toHaveBeenCalled();
    expect(firebaseAdmin.deleteUser).not.toHaveBeenCalled();
    // Los pasos posteriores al que falló sí se ejecutan.
    expect(firestore.anonymizeUserCfdis).toHaveBeenCalled();
  });
});

describe('AccountDeletionService — facturas conservadas', () => {
  it('recorre las páginas de facturas de Stripe', async () => {
    const { service, stripe } = buildService();
    stripe.invoices.list
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, i) => ({ id: `in_${i}` })),
        has_more: true,
      })
      .mockResolvedValueOnce({ data: [{ id: 'in_100' }], has_more: false });

    const result = await service.deleteAccount('uid-1');

    expect(result.retained.invoices).toBe(101);
    expect(stripe.invoices.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ starting_after: 'in_99' }),
    );
  });

  it('cae en el número de CFDI anonimizados si Stripe no contesta al conteo', async () => {
    const { service, stripe } = buildService();
    stripe.invoices.list.mockRejectedValue(new Error('rate limited'));

    const result = await service.deleteAccount('uid-1');

    // 3 CFDI anonimizados: un número comprobado, no una estimación.
    expect(result.retained.invoices).toBe(3);
    expect(result.retained.reason).toBe(RETENTION_REASON_FISCAL);
  });

  it('devuelve cero facturas para un usuario que nunca pagó', async () => {
    const { service } = buildService({
      user: {
        ...baseUser,
        stripeCustomerId: undefined,
        stripeSubscriptionId: undefined,
      },
    });

    const result = await service.deleteAccount('uid-1');

    expect(result.retained.invoices).toBe(0);
  });
});
