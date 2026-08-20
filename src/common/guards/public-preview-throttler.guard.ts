import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';
// Son interfaces: en ESM hay que importarlas como tipo o el arranque muere con
// "does not provide an export named ...".
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { getClientDeclaredIp, getTrustedHopIp } from '../utils/request-ip.js';

/**
 * Ventanas del endpoint publico de vista previa. Son dos identidades porque
 * ninguna sirve sola:
 *
 * - La IP que declara el cliente segmenta bien el trafico legitimo (todos los
 *   visitantes entran por el rewrite del frontend y comparten salto), pero es
 *   falsificable: quien llame directo al servicio de Cloud Run puede mandar un
 *   `X-Forwarded-For` distinto en cada peticion y estrenar contador.
 * - La IP del salto de confianza no se puede falsificar, pero agrupa a todos
 *   los visitantes que comparten edge.
 *
 * Asi que la primera lleva el tope por visitante y la segunda el tope agregado,
 * que es el que de verdad protege el techo compartido de Labelary (plan free:
 * 1 req/s para toda la plataforma).
 */
export const PUBLIC_PREVIEW_THROTTLERS = {
  clientMinute: { limit: 10, ttl: 60000 },
  clientHourly: { limit: 30, ttl: 3600000 },
  peerMinute: { limit: 60, ttl: 60000 },
  peerHourly: { limit: 600, ttl: 3600000 },
} as const;

/** Token de las opciones del guard. */
export const PUBLIC_PREVIEW_THROTTLER_OPTIONS = Symbol(
  'PUBLIC_PREVIEW_THROTTLER_OPTIONS',
);

/** Token del storage exclusivo del guard, para no compartir el Map global. */
export const PUBLIC_PREVIEW_THROTTLER_STORAGE = Symbol(
  'PUBLIC_PREVIEW_THROTTLER_STORAGE',
);

export const publicPreviewThrottlerOptions: ThrottlerModuleOptions = {
  throttlers: [
    {
      name: 'publicPreviewClientMinute',
      ...PUBLIC_PREVIEW_THROTTLERS.clientMinute,
      getTracker: (req) => `client:${getClientDeclaredIp(req)}`,
    },
    {
      name: 'publicPreviewClientHourly',
      ...PUBLIC_PREVIEW_THROTTLERS.clientHourly,
      getTracker: (req) => `client:${getClientDeclaredIp(req)}`,
    },
    {
      name: 'publicPreviewPeerMinute',
      ...PUBLIC_PREVIEW_THROTTLERS.peerMinute,
      getTracker: (req) => `hop:${getTrustedHopIp(req)}`,
    },
    {
      name: 'publicPreviewPeerHourly',
      ...PUBLIC_PREVIEW_THROTTLERS.peerHourly,
      getTracker: (req) => `hop:${getTrustedHopIp(req)}`,
    },
  ],
};

/**
 * Guard de rate limit exclusivo de `POST /zpl/public-preview`.
 *
 * Va con opciones y storage PROPIOS en vez de declarar throttlers extra en
 * `ThrottlerModule.forRoot`: el guard global evalua todos los throttlers
 * declarados ahi en TODAS las rutas, asi que unas ventanas auxiliares —aunque
 * su limite global fuera inalcanzable— multiplicarian por cuatro las claves que
 * cada `status/:jobId` y cada batch dejan en el storage in-memory, que nunca
 * borra keys del Map (ver `CustomThrottlerGuard`). Con storage propio, el coste
 * se queda en las IPs que usan esta ruta.
 *
 * Los `@Inject` explicitos NO son decorativos: `ThrottlerGuard` decora sus dos
 * primeros parametros con los tokens del modulo global, y esa metadata se
 * hereda. Sin sobrescribirla, Nest inyecta aqui las opciones globales y el
 * storage global en las posiciones equivocadas y el guard revienta en la
 * primera peticion.
 */
@Injectable()
export class PublicPreviewThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(PUBLIC_PREVIEW_THROTTLER_OPTIONS) options: ThrottlerModuleOptions,
    @Inject(PUBLIC_PREVIEW_THROTTLER_STORAGE) storage: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storage, reflector);
  }
}

export const publicPreviewThrottlerProviders: Provider[] = [
  {
    provide: PUBLIC_PREVIEW_THROTTLER_OPTIONS,
    useValue: publicPreviewThrottlerOptions,
  },
  // Como provider y no como `new` suelto: asi Nest le aplica su
  // `onApplicationShutdown` y limpia los timers de expiracion al cerrar.
  {
    provide: PUBLIC_PREVIEW_THROTTLER_STORAGE,
    useClass: ThrottlerStorageService,
  },
  PublicPreviewThrottlerGuard,
];
