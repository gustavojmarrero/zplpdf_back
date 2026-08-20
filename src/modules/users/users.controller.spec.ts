import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { UsersController } from './users.controller.js';
import { UsersService, MAX_PROFILE_PHOTO_BYTES } from './users.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';

/**
 * Verifica el contrato HTTP de las acciones del historial: que Nest resuelve
 * las rutas con parámetro (`history/:id` no se come `history`), que el id llega
 * al servicio y que la respuesta tiene la forma `{ success, data }` que espera
 * el frontend.
 *
 * El servicio va mockeado a propósito: su lógica se prueba en
 * users.service.spec.ts. Lo que aquí puede romperse es el cableado.
 */
describe('UsersController — rutas del historial', () => {
  const UID = 'uid-propietario';

  let app: INestApplication;
  let usersService: {
    getUserHistory: jest.Mock;
    deleteHistoryEntry: jest.Mock;
    getHistoryZpl: jest.Mock;
  };

  beforeEach(async () => {
    usersService = {
      getUserHistory: jest.fn().mockResolvedValue([]),
      deleteHistoryEntry: jest
        .fn()
        .mockResolvedValue({ id: 'hist-1', deleted: true }),
      getHistoryZpl: jest.fn().mockResolvedValue({
        zplContent: '^XA^FDhola^FS^XZ',
        labelSize: '4x6',
        outputFormat: 'pdf',
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: usersService },
        {
          provide: AccountDeletionService,
          useValue: { deleteAccount: jest.fn() },
        },
      ],
    })
      .overrideGuard(FirebaseAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = { uid: UID };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('DELETE /users/history/:id pasa el id y devuelve { success, data }', async () => {
    const response = await request(app.getHttpServer())
      .delete('/users/history/hist-1')
      .expect(200);

    expect(usersService.deleteHistoryEntry).toHaveBeenCalledWith(UID, 'hist-1');
    expect(response.body).toEqual({
      success: true,
      data: { id: 'hist-1', deleted: true },
    });
  });

  it('GET /users/history/:id/zpl devuelve el ZPL con su tamaño y formato', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/history/hist-1/zpl')
      .expect(200);

    expect(usersService.getHistoryZpl).toHaveBeenCalledWith(UID, 'hist-1');
    expect(response.body).toEqual({
      success: true,
      data: {
        zplContent: '^XA^FDhola^FS^XZ',
        labelSize: '4x6',
        outputFormat: 'pdf',
      },
    });
  });

  it('GET /users/history sigue resolviendo al listado, no a la ruta con parámetro', async () => {
    await request(app.getHttpServer()).get('/users/history').expect(200);

    expect(usersService.getUserHistory).toHaveBeenCalledWith(UID, {});
    expect(usersService.getHistoryZpl).not.toHaveBeenCalled();
  });

  it('propaga el 410 del ZPL caducado con su código de error', async () => {
    // El frontend distingue "ya no está" de "no existe" por este código.
    const { GoneException } = await import('@nestjs/common');
    usersService.getHistoryZpl.mockRejectedValue(
      new GoneException({
        error: 'ZPL_NOT_AVAILABLE',
        message: 'gone',
        data: { retentionDays: 15 },
      }),
    );

    const response = await request(app.getHttpServer())
      .get('/users/history/hist-1/zpl')
      .expect(410);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('ZPL_NOT_AVAILABLE');
    expect(response.body.data).toEqual({ retentionDays: 15 });
  });

  it('propaga el 404 de un registro ajeno o inexistente', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    usersService.deleteHistoryEntry.mockRejectedValue(
      new NotFoundException({
        error: 'HISTORY_NOT_FOUND',
        message: 'History record not found',
      }),
    );

    const response = await request(app.getHttpServer())
      .delete('/users/history/hist-ajeno')
      .expect(404);

    expect(response.body.error).toBe('HISTORY_NOT_FOUND');
  });
});

/**
 * El contrato de la foto de perfil se apoya en dos piezas de cableado que solo
 * fallan en HTTP real: que el multipart llegue al servicio como `file`, y que el
 * corte por tamaño de multer salga con `IMAGE_TOO_LARGE` y no con el código
 * genérico del filtro. El frontend está en cuatro idiomas y traduce por código.
 */
describe('UsersController — foto de perfil', () => {
  const UID = 'uid-foto';
  const PHOTO_URL =
    'https://storage.googleapis.com/zplpdf-public-assets/users/uid-foto/avatar.webp?v=1';

  let app: INestApplication;
  let usersService: {
    uploadProfilePhoto: jest.Mock;
    deleteProfilePhoto: jest.Mock;
  };

  beforeEach(async () => {
    usersService = {
      uploadProfilePhoto: jest.fn().mockResolvedValue({ photoURL: PHOTO_URL }),
      deleteProfilePhoto: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: usersService },
        {
          provide: AccountDeletionService,
          useValue: { deleteAccount: jest.fn() },
        },
      ],
    })
      .overrideGuard(FirebaseAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = { uid: UID };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /users/me/photo pasa el archivo al servicio y devuelve { photoURL }', async () => {
    const response = await request(app.getHttpServer())
      .post('/users/me/photo')
      .attach('file', Buffer.alloc(1024), {
        filename: 'avatar.png',
        contentType: 'image/png',
      })
      .expect(200);

    expect(response.body).toEqual({ photoURL: PHOTO_URL });
    const [uid, file] = usersService.uploadProfilePhoto.mock.calls[0];
    expect(uid).toBe(UID);
    expect(file.originalname).toBe('avatar.png');
    expect(file.buffer).toHaveLength(1024);
  });

  it('POST /users/me/photo corta por tamaño con IMAGE_TOO_LARGE sin llegar al servicio', async () => {
    // Multer aborta antes que el handler: el interceptor traductor es lo único
    // que impide que el frontend reciba el código del ZPL (FILE_TOO_LARGE) con
    // otro límite.
    const response = await request(app.getHttpServer())
      .post('/users/me/photo')
      .attach('file', Buffer.alloc(MAX_PROFILE_PHOTO_BYTES + 1024), {
        filename: 'enorme.png',
        contentType: 'image/png',
      })
      .expect(413);

    expect(response.body.error).toBe('IMAGE_TOO_LARGE');
    expect(usersService.uploadProfilePhoto).not.toHaveBeenCalled();
  });

  it('DELETE /users/me/photo responde 204 sin cuerpo', async () => {
    const response = await request(app.getHttpServer())
      .delete('/users/me/photo')
      .expect(204);

    expect(usersService.deleteProfilePhoto).toHaveBeenCalledWith(UID);
    expect(response.body).toEqual({});
  });

  it('DELETE /users/me/photo no colisiona con DELETE /users/history/:id', async () => {
    // `history/:id` y `me/photo` conviven en el mismo controlador; si el orden
    // de declaración fuera otro, el borrado de foto entraría por el historial.
    await request(app.getHttpServer()).delete('/users/me/photo').expect(204);

    expect(usersService.deleteProfilePhoto).toHaveBeenCalledTimes(1);
  });
});

/**
 * Contrato HTTP de la baja de cuenta y de las preferencias (issue #99). La
 * lógica vive en sus servicios; aquí se comprueba el cableado: que las rutas
 * `me/...` no se coman a `me`, que el body se valida y que los códigos de error
 * llegan al cliente tal cual, que es como el frontend distingue los casos.
 */
describe('UsersController — baja de cuenta y preferencias', () => {
  const UID = 'uid-titular';

  let app: INestApplication;
  let usersService: {
    getUserProfile: jest.Mock;
    getNotificationPreferences: jest.Mock;
    updateNotificationPreferences: jest.Mock;
  };
  let accountDeletionService: { deleteAccount: jest.Mock };

  const deletionResult = {
    deleted: {
      conversions: 128,
      storedFiles: 120,
      taxProfile: true,
      subscription: {
        cancelled: true,
        plan: 'pro',
        effectiveAt: '2026-09-01T00:00:00.000Z',
      },
    },
    retained: { invoices: 4, reason: 'fiscal_retention' },
  };

  beforeEach(async () => {
    usersService = {
      getUserProfile: jest.fn().mockResolvedValue({ id: UID }),
      getNotificationPreferences: jest.fn().mockResolvedValue({
        product: true,
        billing: true,
        usageReminders: true,
      }),
      updateNotificationPreferences: jest.fn().mockResolvedValue({
        product: false,
        billing: true,
        usageReminders: true,
      }),
    };
    accountDeletionService = {
      deleteAccount: jest.fn().mockResolvedValue(deletionResult),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: usersService },
        {
          provide: AccountDeletionService,
          useValue: accountDeletionService,
        },
      ],
    })
      .overrideGuard(FirebaseAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = { uid: UID };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    const { ValidationPipe } = await import('@nestjs/common');
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('DELETE /users/me devuelve el contrato con deleted y retained', async () => {
    const response = await request(app.getHttpServer())
      .delete('/users/me')
      .expect(200);

    expect(accountDeletionService.deleteAccount).toHaveBeenCalledWith(UID);
    expect(response.body).toEqual(deletionResult);
  });

  it('propaga SUBSCRIPTION_CANCEL_FAILED con su data', async () => {
    const { HttpException, HttpStatus } = await import('@nestjs/common');
    accountDeletionService.deleteAccount.mockRejectedValue(
      new HttpException(
        {
          error: 'SUBSCRIPTION_CANCEL_FAILED',
          message: 'no',
          data: { plan: 'pro', subscriptionId: 'sub_1', reason: 'api_error' },
        },
        HttpStatus.CONFLICT,
      ),
    );

    const response = await request(app.getHttpServer())
      .delete('/users/me')
      .expect(409);

    expect(response.body.error).toBe('SUBSCRIPTION_CANCEL_FAILED');
    expect(response.body.data.reason).toBe('api_error');
  });

  it('propaga ACCOUNT_DELETION_PARTIAL con accountDeleted y failedSteps', async () => {
    const { HttpException, HttpStatus } = await import('@nestjs/common');
    accountDeletionService.deleteAccount.mockRejectedValue(
      new HttpException(
        {
          error: 'ACCOUNT_DELETION_PARTIAL',
          message: 'partial',
          data: { accountDeleted: false, failedSteps: ['account'] },
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      ),
    );

    const response = await request(app.getHttpServer())
      .delete('/users/me')
      .expect(500);

    expect(response.body.error).toBe('ACCOUNT_DELETION_PARTIAL');
    expect(response.body.data).toEqual({
      accountDeleted: false,
      failedSteps: ['account'],
    });
  });

  it('GET /users/me/preferences no se resuelve como GET /users/me', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/me/preferences')
      .expect(200);

    expect(usersService.getNotificationPreferences).toHaveBeenCalledWith(UID);
    expect(usersService.getUserProfile).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      notifications: { product: true, billing: true, usageReminders: true },
    });
  });

  it('PUT /users/me/preferences pasa el bloque notifications y devuelve el estado completo', async () => {
    const response = await request(app.getHttpServer())
      .put('/users/me/preferences')
      .send({ notifications: { product: false } })
      .expect(200);

    expect(usersService.updateNotificationPreferences).toHaveBeenCalledWith(
      UID,
      { product: false },
    );
    expect(response.body).toEqual({
      notifications: { product: false, billing: true, usageReminders: true },
    });
  });

  it('rechaza un interruptor que no sea booleano', async () => {
    await request(app.getHttpServer())
      .put('/users/me/preferences')
      .send({ notifications: { product: 'sí' } })
      .expect(400);

    expect(usersService.updateNotificationPreferences).not.toHaveBeenCalled();
  });
});
