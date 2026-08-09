import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
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
      providers: [{ provide: UsersService, useValue: usersService }],
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
