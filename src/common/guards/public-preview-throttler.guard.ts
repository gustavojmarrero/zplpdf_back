import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { BoundedThrottlerStorage } from './bounded-throttler.storage.js';
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
 * 1 req/s para toda la plataforma, o sea 60 llamadas/minuto).
 *
 * Los numeros del tope agregado se cuentan en LLAMADAS A LABELARY, no en
 * peticiones: cada peticion anonima renderiza hasta
 * `PUBLIC_PREVIEW_MAX_UNIQUE_LABELS` (2) etiquetas unicas, y cada etiqueta es
 * una llamada. 15 peticiones/minuto son como mucho 30 llamadas/minuto — la
 * mitad del techo — para que el trafico anonimo nunca pueda dejar sin cola a
 * las conversiones de quien paga. En la hora, 300 peticiones son como mucho
 * 600 llamadas, un 17% del techo sostenido.
 */
export const PUBLIC_PREVIEW_THROTTLERS = {
  clientMinute: { limit: 6, ttl: 60000 },
  clientHourly: { limit: 30, ttl: 3600000 },
  peerMinute: { limit: 15, ttl: 60000 },
  peerHourly: { limit: 300, ttl: 3600000 },
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
 * El orden de evaluacion importa, y va al reves de lo que parece: `ThrottlerGuard`
 * recorre los throttlers, incrementa el contador de cada uno y lanza en el
 * primero que se pase, asi que TODO lo que se evalue antes del que rechaza ya ha
 * consumido cupo. Por eso las ventanas por visitante van primero: si fuera al
 * reves, las peticiones que se rechazan por el tope del visitante seguirian
 * gastando el cubo agregado, y a un solo visitante le bastarian 6 peticiones
 * buenas mas 9 rechazadas para agotar el minuto compartido y dejar sin vista
 * previa a TODOS los que comparten salto — un DoS de 15 peticiones contra la
 * pagina que este endpoint venia a abrir.
 *
 * Evaluar primero al visitante tiene una contrapartida conocida: quien rote el
 * `X-Forwarded-For` estrena clave en cada peticion antes de que el tope
 * agregado le corte. Eso lo acota `BoundedThrottlerStorage` con su expulsion
 * LRU, que es donde ese problema se resuelve de verdad; el orden de evaluacion
 * nunca fue la herramienta adecuada para ello.
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

  async onModuleInit(): Promise<void> {
    await super.onModuleInit();

    // super ordena por ttl, que aqui no es el criterio que hace falta: lo que
    // decide quien consume cupo es el orden, y el visitante va primero (ver el
    // comentario de la clase). Un nombre que no este en la lista se queda al
    // final en vez de romper el orden de los que si estan.
    this.throttlers.sort(
      (a, b) => ordenDeEvaluacion(a.name) - ordenDeEvaluacion(b.name),
    );
  }
}

/**
 * Orden explicito y no una heuristica sobre el nombre: quien anada una ventana
 * nueva tiene que decidir a proposito si consume cupo agregado o no.
 */
const ORDEN_DE_EVALUACION = [
  'publicPreviewClientMinute',
  'publicPreviewClientHourly',
  'publicPreviewPeerMinute',
  'publicPreviewPeerHourly',
];

function ordenDeEvaluacion(name?: string): number {
  const posicion = ORDEN_DE_EVALUACION.indexOf(name ?? '');
  return posicion === -1 ? ORDEN_DE_EVALUACION.length : posicion;
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
    useClass: BoundedThrottlerStorage,
  },
  PublicPreviewThrottlerGuard,
];
