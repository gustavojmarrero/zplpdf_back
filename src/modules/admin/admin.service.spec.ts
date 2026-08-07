// Evitar la conexión real a Google Cloud Storage / Stripe al cargar el módulo.
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn() })),
}));
jest.mock('stripe', () => jest.fn());

import { AdminService } from './admin.service.js';

/**
 * Los eventos de cuota/acceso anteriores al fix del conversion-gate se
 * guardaron con `userId` pero sin `userEmail`. Al leerlos, el dashboard debe
 * resolver el email para poder enlazar a la ficha del usuario: /admin/users
 * busca por email o displayName, nunca por uid.
 */
describe('AdminService — enriquecimiento de userEmail en error logs', () => {
  /**
   * AdminService tiene un constructor con muchas dependencias que estos tests
   * no ejercitan. Instanciamos por prototipo e inyectamos solo el firestore.
   */
  function buildService(getUserEmailsByIds: jest.Mock): any {
    const service = Object.create(AdminService.prototype);
    service.firestoreService = { getUserEmailsByIds };
    return service;
  }

  it('rellena el email de los eventos que solo tienen userId', async () => {
    const getUserEmailsByIds = jest
      .fn()
      .mockResolvedValue(new Map([['uid-1', 'usuario@ejemplo.com']]));
    const service = buildService(getUserEmailsByIds);

    const result = await service.fillMissingUserEmails([
      { id: 'e1', userId: 'uid-1', userEmail: undefined },
    ]);

    expect(result[0].userEmail).toBe('usuario@ejemplo.com');
    expect(getUserEmailsByIds).toHaveBeenCalledWith(['uid-1']);
  });

  it('no toca los eventos que ya traen email ni los que no tienen userId', async () => {
    const getUserEmailsByIds = jest
      .fn()
      .mockResolvedValue(new Map([['uid-2', 'resuelto@ejemplo.com']]));
    const service = buildService(getUserEmailsByIds);

    const result = await service.fillMissingUserEmails([
      { id: 'e1', userId: 'uid-1', userEmail: 'original@ejemplo.com' },
      { id: 'e2', userId: 'uid-2' },
      { id: 'e3' },
    ]);

    expect(result[0].userEmail).toBe('original@ejemplo.com');
    expect(result[1].userEmail).toBe('resuelto@ejemplo.com');
    expect(result[2].userEmail).toBeUndefined();
    // Solo se pide el id que faltaba.
    expect(getUserEmailsByIds).toHaveBeenCalledWith(['uid-2']);
  });

  it('no hace ninguna lectura si no hay huecos que rellenar', async () => {
    const getUserEmailsByIds = jest.fn();
    const service = buildService(getUserEmailsByIds);

    const items = [{ id: 'e1', userId: 'uid-1', userEmail: 'ya@ejemplo.com' }];
    const result = await service.fillMissingUserEmails(items);

    expect(getUserEmailsByIds).not.toHaveBeenCalled();
    expect(result).toBe(items);
  });

  it('deja el evento intacto si el usuario ya no existe', async () => {
    const getUserEmailsByIds = jest.fn().mockResolvedValue(new Map());
    const service = buildService(getUserEmailsByIds);

    const result = await service.fillMissingUserEmails([
      { id: 'e1', userId: 'uid-borrado' },
    ]);

    expect(result[0].userEmail).toBeUndefined();
    expect(result[0].userId).toBe('uid-borrado');
  });
});
