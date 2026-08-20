import { PublicPreviewThrottlerGuard } from './public-preview-throttler.guard.js';
import {
  PUBLIC_PREVIEW_THROTTLERS,
  publicPreviewThrottlerOptions,
} from './public-preview-throttler.guard.js';
import { BoundedThrottlerStorage } from './bounded-throttler.storage.js';
import { PUBLIC_PREVIEW_MAX_UNIQUE_LABELS } from '../../modules/zpl/dto/public-preview.dto.js';

/** Techo del plan free de Labelary: 1 req/s = 60 llamadas por minuto. */
const LLAMADAS_LABELARY_POR_MINUTO = 60;

describe('PublicPreviewThrottlerGuard', () => {
  const buildGuard = () => {
    const storage = new BoundedThrottlerStorage();
    const reflector: any = { getAllAndOverride: jest.fn() };
    const guard = new PublicPreviewThrottlerGuard(
      publicPreviewThrottlerOptions,
      storage,
      reflector,
    );
    return { guard, storage };
  };

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
});
