import { PublicPreviewThrottlerGuard } from './public-preview-throttler.guard.js';
import {
  PUBLIC_PREVIEW_THROTTLERS,
  publicPreviewThrottlerOptions,
} from './public-preview-throttler.guard.js';
import { BoundedThrottlerStorage } from './bounded-throttler.storage.js';
import { PUBLIC_PREVIEW_MAX_UNIQUE_LABELS } from '../../modules/zpl/dto/public-preview.dto.js';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';

/** Techo del plan free de Labelary: 1 req/s = 60 llamadas por minuto. */
const LLAMADAS_LABELARY_POR_MINUTO = 60;

describe('PublicPreviewThrottlerGuard', () => {
  const buildGuard = () => {
    const storage = new BoundedThrottlerStorage();
    const reflector = new Reflector();
    const guard = new PublicPreviewThrottlerGuard(
      publicPreviewThrottlerOptions,
      storage,
      reflector,
    );
    return { guard, storage };
  };

  const buildContext = (forwardedFor: string) => {
    const request = {
      headers: { 'x-forwarded-for': forwardedFor },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const response = { header: jest.fn() };

    return {
      getClass: () => class ZplController {},
      getHandler: () => function publicPreview() {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as any;
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('evalúa primero las ventanas que no se pueden falsificar', async () => {
    const { guard, storage } = buildGuard();

    await guard.onModuleInit();

    const nombres = (guard as any).throttlers.map((t: any) => t.name);
    expect(nombres[0]).toContain('Peer');
    expect(nombres[1]).toContain('Peer');
    storage.onApplicationShutdown();
  });

  it('el tope agregado deja a Labelary la mitad de su capacidad libre', () => {
    // Cada peticion anonima renderiza hasta N etiquetas y cada etiqueta es una
    // llamada: lo que hay que comparar con el techo son las llamadas.
    const llamadasPorMinuto =
      PUBLIC_PREVIEW_THROTTLERS.peerMinute.limit *
      PUBLIC_PREVIEW_MAX_UNIQUE_LABELS;

    expect(llamadasPorMinuto).toBeLessThanOrEqual(
      LLAMADAS_LABELARY_POR_MINUTO / 2,
    );
  });

  it('un solo visitante no puede vaciar el cubo agregado', () => {
    expect(PUBLIC_PREVIEW_THROTTLERS.clientMinute.limit).toBeLessThan(
      PUBLIC_PREVIEW_THROTTLERS.peerMinute.limit,
    );
    expect(PUBLIC_PREVIEW_THROTTLERS.clientHourly.limit).toBeLessThan(
      PUBLIC_PREVIEW_THROTTLERS.peerHourly.limit,
    );
  });

  it('corta en la peticion 7 cuando el visitante mantiene su IP', async () => {
    jest.useFakeTimers();
    const { guard, storage } = buildGuard();
    await guard.onModuleInit();
    const context = buildContext('203.0.113.10, 198.51.100.7');

    for (let i = 0; i < PUBLIC_PREVIEW_THROTTLERS.clientMinute.limit; i++) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    storage.onApplicationShutdown();
  });

  it('corta en la peticion 16 aunque rote la IP declarada', async () => {
    jest.useFakeTimers();
    const { guard, storage } = buildGuard();
    await guard.onModuleInit();
    const peer = '198.51.100.7';

    for (let i = 0; i < PUBLIC_PREVIEW_THROTTLERS.peerMinute.limit; i++) {
      const context = buildContext(`203.0.113.${i}, ${peer}`);
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    const bloqueada = buildContext(`203.0.113.200, ${peer}`);
    await expect(guard.canActivate(bloqueada)).rejects.toBeInstanceOf(
      ThrottlerException,
    );

    // La peticion bloqueada se corta en el tracker de origen, antes de crear
    // los dos contadores correspondientes a la nueva IP declarada.
    expect(storage.storage.size).toBe(32);
    storage.onApplicationShutdown();
  });
});
