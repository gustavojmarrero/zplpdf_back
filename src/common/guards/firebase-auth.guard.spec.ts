import { UnauthorizedException } from '@nestjs/common';
import { FirebaseAuthGuard } from './firebase-auth.guard.js';

/**
 * El guard crea el documento de usuario a la primera petición autenticada
 * ("lazy user creation"). Un ID token sigue siendo criptográficamente válido
 * hasta una hora después de borrar la cuenta, así que sin comprobar Firebase
 * Auth esa creación resucitaría cualquier cuenta recién dada de baja (issue
 * #99).
 */
describe('FirebaseAuthGuard — cuentas borradas', () => {
  function buildContext(token = 'token-valido') {
    const request: Record<string, any> = {
      headers: { authorization: `Bearer ${token}` },
    };
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as any,
    };
  }

  function buildGuard(options: {
    storedUser?: Record<string, any> | null;
    getUser?: jest.Mock;
    deletionMarked?: boolean;
  }) {
    const createUser = jest.fn().mockResolvedValue(undefined);
    const getUser =
      options.getUser ??
      jest.fn().mockResolvedValue({ uid: 'uid-1', emailVerified: true });

    const guard = new FirebaseAuthGuard(
      {
        verifyToken: jest
          .fn()
          .mockResolvedValue({ uid: 'uid-1', email: 'user@example.com' }),
        getUser,
      } as any,
      {
        isAccountDeletionMarked: jest
          .fn()
          .mockResolvedValue(options.deletionMarked ?? false),
        getUserById: jest.fn().mockResolvedValue(options.storedUser ?? null),
        createUser,
      } as any,
    );

    return { guard, createUser, getUser };
  }

  it('no recrea el perfil de una cuenta que ya no existe en Firebase Auth', async () => {
    const { guard, createUser } = buildGuard({
      storedUser: null,
      getUser: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('no user'), { code: 'auth/user-not-found' }),
        ),
    });
    const { context } = buildContext();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(createUser).not.toHaveBeenCalled();
  });

  it('no recrea ni admite un uid con una baja marcada aunque Auth siga vivo', async () => {
    const { guard, createUser, getUser } = buildGuard({
      storedUser: null,
      deletionMarked: true,
    });
    const { context } = buildContext();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Durante el barrido Auth existe todavía: consultarlo no puede convertir
    // esa existencia transitoria en permiso para resucitar el perfil.
    expect(getUser).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('sigue creando el perfil de un usuario nuevo cuya cuenta sí existe', async () => {
    const { guard, createUser } = buildGuard({ storedUser: null });
    const { context, request } = buildContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(createUser).toHaveBeenCalled();
    expect(request.user.uid).toBe('uid-1');
  });

  it('no comprueba Firebase Auth cuando el perfil ya existe', async () => {
    const { guard, getUser, createUser } = buildGuard({
      storedUser: {
        id: 'uid-1',
        email: 'user@example.com',
        displayName: 'User',
      },
    });
    const { context } = buildContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // El camino caliente no paga la llamada extra.
    expect(getUser).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('un fallo de Firebase Auth distinto de user-not-found no bloquea el alta', async () => {
    const { guard, createUser } = buildGuard({
      storedUser: null,
      getUser: jest.fn().mockRejectedValue(new Error('auth caído')),
    });
    const { context } = buildContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(createUser).toHaveBeenCalled();
  });
});
