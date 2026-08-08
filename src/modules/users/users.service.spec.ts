// Evitar la conexión real a Stripe al cargar el módulo.
jest.mock('stripe', () => jest.fn());

import {
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import { ZPL_RETENTION_DAYS } from '../../common/interfaces/conversion-history.interface.js';

/**
 * Acciones del historial: borrar una fila y recuperar el ZPL original para
 * reconvertir.
 *
 * Dos riesgos concretos guían estos tests:
 *
 *  1. El id de `conversion_history` viaja en la URL. Sin comprobación de
 *     ownership, cualquier usuario con plan de pago leería el ZPL de otro —
 *     que es su dato de negocio (SKUs, direcciones, lotes).
 *  2. El contador mensual no puede depender del historial. Si borrar filas
 *     descontara PDFs, la cuota se reiniciaría vaciando la tabla.
 */
describe('UsersService — acciones sobre el historial', () => {
  const UID = 'uid-propietario';
  const OTRO_UID = 'uid-ajeno';
  const HISTORY_ID = 'hist-1';

  const diasAtras = (dias: number) =>
    new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  function registroDeHistorial(overrides: Record<string, unknown> = {}) {
    return {
      id: HISTORY_ID,
      userId: UID,
      jobId: 'job-1',
      labelCount: 3,
      labelSize: '4x6',
      status: 'completed',
      outputFormat: 'pdf',
      createdAt: new Date(),
      ...overrides,
    };
  }

  function buildService(overrides: {
    user?: Record<string, unknown> | null;
    record?: Record<string, unknown> | null;
    debugFile?: Record<string, unknown> | null;
    zplContent?: string | null;
    history?: Record<string, unknown>[];
    jobIdsConZpl?: Set<string> | Error;
  }) {
    const firestoreService = {
      getUserById: jest
        .fn()
        .mockResolvedValue(
          overrides.user === undefined
            ? { id: UID, plan: 'pro', role: 'user' }
            : overrides.user,
        ),
      getConversionHistoryById: jest
        .fn()
        .mockResolvedValue(
          overrides.record === undefined
            ? registroDeHistorial()
            : overrides.record,
        ),
      deleteConversionHistory: jest.fn().mockResolvedValue(undefined),
      getZplDebugFileByJobId: jest
        .fn()
        .mockResolvedValue(
          overrides.debugFile === undefined
            ? { userId: UID, storagePath: 'debug-zpl/uid/2026-08-08/job-1.zpl' }
            : overrides.debugFile,
        ),
      getUserConversionHistory: jest
        .fn()
        .mockResolvedValue(overrides.history ?? []),
      getJobIdsWithSavedZpl: jest
        .fn()
        .mockImplementation((jobIds: string[]) => {
          if (overrides.jobIdsConZpl instanceof Error) {
            return Promise.reject(overrides.jobIdsConZpl);
          }
          // Por defecto, todos los jobs del historial tienen su ZPL guardado.
          return Promise.resolve(overrides.jobIdsConZpl ?? new Set(jobIds));
        }),
      // Si algún camino intentara tocar la cuota, el test lo vería aquí.
      incrementUsage: jest.fn(),
      updateUsage: jest.fn(),
      resetUsage: jest.fn(),
    };

    const storageService = {
      readTextFile: jest
        .fn()
        .mockResolvedValue(
          overrides.zplContent === undefined
            ? '^XA^FDhola^FS^XZ'
            : overrides.zplContent,
        ),
      generateSignedUrlForPath: jest
        .fn()
        .mockResolvedValue('https://signed.example/file.pdf'),
    };

    const service = Object.create(UsersService.prototype) as UsersService;
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      firestoreService,
      storageService,
    });

    return { service, firestoreService, storageService };
  }

  describe('deleteHistoryEntry', () => {
    it('borra el registro y devuelve el id', async () => {
      const { service, firestoreService } = buildService({});

      await expect(
        service.deleteHistoryEntry(UID, HISTORY_ID),
      ).resolves.toEqual({ id: HISTORY_ID, deleted: true });
      expect(firestoreService.deleteConversionHistory).toHaveBeenCalledWith(
        HISTORY_ID,
      );
    });

    it('no toca el uso mensual al borrar', async () => {
      // Si el borrado descontara PDFs del período, bastaría con vaciar el
      // historial para reiniciar la cuota del mes.
      const { service, firestoreService } = buildService({});

      await service.deleteHistoryEntry(UID, HISTORY_ID);

      expect(firestoreService.incrementUsage).not.toHaveBeenCalled();
      expect(firestoreService.updateUsage).not.toHaveBeenCalled();
      expect(firestoreService.resetUsage).not.toHaveBeenCalled();
    });

    it('responde 404 —no 403— ante un registro de otro usuario, y no lo borra', async () => {
      // Un 403 confirmaría que el id existe; el id va en la URL y es adivinable.
      const { service, firestoreService } = buildService({
        record: registroDeHistorial({ userId: OTRO_UID }),
      });

      await expect(
        service.deleteHistoryEntry(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(firestoreService.deleteConversionHistory).not.toHaveBeenCalled();
    });

    it('responde 404 cuando el registro no existe', async () => {
      const { service } = buildService({ record: null });

      await expect(
        service.deleteHistoryEntry(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza a los planes sin historial antes de leer nada', async () => {
      const { service, firestoreService } = buildService({
        user: { id: UID, plan: 'lite', role: 'user' },
      });

      await expect(
        service.deleteHistoryEntry(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(firestoreService.getConversionHistoryById).not.toHaveBeenCalled();
      expect(firestoreService.deleteConversionHistory).not.toHaveBeenCalled();
    });
  });

  describe('getHistoryZpl', () => {
    it('devuelve el ZPL con el tamaño y el formato del registro', async () => {
      const { service, storageService } = buildService({});

      await expect(service.getHistoryZpl(UID, HISTORY_ID)).resolves.toEqual({
        zplContent: '^XA^FDhola^FS^XZ',
        labelSize: '4x6',
        outputFormat: 'pdf',
      });
      expect(storageService.readTextFile).toHaveBeenCalledWith(
        'debug-zpl/uid/2026-08-08/job-1.zpl',
      );
    });

    it('responde 404 ante un registro de otro usuario, sin leer el ZPL', async () => {
      const { service, storageService, firestoreService } = buildService({
        record: registroDeHistorial({ userId: OTRO_UID }),
      });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(firestoreService.getZplDebugFileByJobId).not.toHaveBeenCalled();
      expect(storageService.readTextFile).not.toHaveBeenCalled();
    });

    it('responde 410 —no 500— cuando el archivo ya salió del bucket', async () => {
      // El lifecycle de `debug-zpl/` borra en GCS pero deja el doc de
      // `zpl_debug_files`: la ausencia solo se ve al leer el objeto.
      const { service } = buildService({ zplContent: null });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('responde 410 cuando nunca se guardó el ZPL del job', async () => {
      // saveZplForDebug es fire-and-forget: puede haber fallado.
      const { service } = buildService({ debugFile: null });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('rechaza a los planes sin historial', async () => {
      const { service } = buildService({
        user: { id: UID, plan: 'free', role: 'user' },
      });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getUserHistory — flag canReconvert', () => {
    it('marca reconvertible lo que sigue dentro de la ventana de retención', async () => {
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
      });

      const [record] = await service.getUserHistory(UID);

      expect(record.canReconvert).toBe(true);
    });

    it('marca no reconvertible lo que ya la superó', async () => {
      // El frontend deshabilita el botón con esto en vez de descubrirlo con un 410.
      const { service } = buildService({
        history: [
          registroDeHistorial({ createdAt: diasAtras(ZPL_RETENTION_DAYS + 1) }),
        ],
      });

      const [record] = await service.getUserHistory(UID);

      expect(record.canReconvert).toBe(false);
    });

    it('expone el id del documento, que es la clave de las dos acciones nuevas', async () => {
      const { service } = buildService({
        history: [registroDeHistorial()],
      });

      const [record] = await service.getUserHistory(UID);

      expect(record.id).toBe(HISTORY_ID);
    });

    it('no promete reconvertir una fila cuyo ZPL nunca se guardó', async () => {
      // Las filas que el flujo batch creó antes de que guardara el ZPL son
      // recientes pero irrecuperables: por edad saldrían como reconvertibles y
      // el botón devolvería 410 al pulsarlo.
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        jobIdsConZpl: new Set<string>(),
      });

      const [record] = await service.getUserHistory(UID);

      expect(record.canReconvert).toBe(false);
    });

    it('degrada a no reconvertible si la consulta de ZPLs falla', async () => {
      // Un botón de más deshabilitado es preferible a prometer un 410, y a que
      // el listado entero reviente por un flag.
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        jobIdsConZpl: new Error('firestore caído'),
      });

      const [record] = await service.getUserHistory(UID);

      expect(record.canReconvert).toBe(false);
    });
  });
});
