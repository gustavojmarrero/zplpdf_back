import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  PriceCatalog,
  SELLABLE_PLANS,
  currencyForCountry,
  intervalFromStripe,
} from './price-catalog.js';
import type {
  BillingInterval,
  PriceCurrency,
  PriceRef,
  SellablePlan,
} from './price-catalog.js';
import type {
  PlanOfferDto,
  PlanPriceDto,
  PlansResponseDto,
} from './dto/plans.dto.js';

/**
 * Importe validado de cada precio publicable, en unidad mínima, por variable de
 * entorno y no por price ID: si el mismo ID estuviera en dos variables, el que
 * no cuadra con la suya no debe heredar la validación del otro.
 */
type ImportesValidados = ReadonlyMap<string, number>;

/**
 * Precios de venta para la página de precios pública (`GET /payments/plans`).
 *
 * Lee los importes de Stripe en lugar de duplicarlos: el frontend los tenía
 * fijos en el código y el descuento anual que enseñe tiene que ser el que el
 * checkout va a cobrar.
 *
 * La ruta es anónima, así que Stripe no puede quedar detrás de cada visita. Los
 * importes se guardan en memoria una hora y, pasada esa hora, se siguen
 * sirviendo al instante mientras se refrescan en segundo plano: con una sola
 * instancia en Cloud Run, visitas colgadas de un Stripe lento agotarían la
 * concurrencia del contenedor y arrastrarían al resto del API. Solo espera a
 * Stripe quien no tiene copia que servir (arranque en frío). Las rondas se
 * comparten, y tras un fallo no se reintenta durante un minuto (diez si es de
 * credenciales, que no se arregla solo).
 *
 * Servir una copia vieja es seguro: el importe de un precio de Stripe no se
 * puede editar, y cambiar de precio exige cambiar la variable y redesplegar.
 */
@Injectable()
export class PlanCatalogService implements OnModuleInit {
  private readonly logger = new Logger(PlanCatalogService.name);
  private stripe: Stripe;
  private readonly catalog: PriceCatalog;

  static readonly CACHE_TTL_MS = 60 * 60 * 1000;
  /** Sin esto, con Stripe caído cada visita volvería a lanzar la ronda completa. */
  static readonly FAILURE_BACKOFF_MS = 60 * 1000;
  /**
   * Un 401/403 es de configuración: reintentarlo cada minuto solo repetiría el
   * mismo CRITICAL en los logs hasta que alguien corrija la key.
   */
  static readonly AUTH_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

  private cache: { importes: ImportesValidados; fetchedAt: number } | null =
    null;
  private enVuelo: Promise<ImportesValidados> | null = null;
  private ultimoFalloAt: number | null = null;
  private backoffMs = PlanCatalogService.FAILURE_BACKOFF_MS;

  constructor(private readonly configService: ConfigService) {
    this.catalog = PriceCatalog.fromConfig((key) =>
      this.configService.get<string>(key),
    );

    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');

    if (!stripeSecretKey) {
      this.logger.warn(
        'Stripe secret key not configured. Public plan prices disabled.',
      );
      return;
    }

    // Acotado: con los valores por defecto del SDK (80 s × 3 intentos) una
    // visita en frío podía esperar minutos por una lectura que no llega.
    this.stripe = new Stripe(stripeSecretKey, {
      timeout: 10_000,
      maxNetworkRetries: 1,
    });
  }

  /**
   * Precalienta la caché para que el primer visitante tras un arranque en frío
   * no espere a Stripe. Sin `await` y sin propagar: un fallo aquí no debe
   * impedir que arranque el resto del API.
   */
  onModuleInit(): void {
    if (!this.stripe) return;

    // El fallo ya lo registra `refrescar`; aquí solo se evita el rechazo sin
    // manejar.
    this.cargarImportes().catch(() => undefined);
  }

  async getPlans(country?: string): Promise<PlansResponseDto> {
    if (!this.stripe) {
      throw this.noDisponible();
    }

    const currency = currencyForCountry(country);
    const importes = await this.cargarImportes();

    const plans: PlanOfferDto[] = [];
    for (const plan of SELLABLE_PLANS) {
      const monthly = this.precio(
        this.refPara(plan, currency, 'monthly'),
        importes,
      );
      // Sin mensual no hay con qué comparar el anual ni qué cobrar por defecto:
      // el plan no se publica y el frontend conserva lo que ya tenía.
      if (!monthly) continue;

      const yearly = this.precio(
        this.refPara(plan, currency, 'yearly'),
        importes,
      );

      plans.push({
        plan,
        monthly,
        yearly: yearly
          ? {
              ...yearly,
              monthlyEquivalent: Math.round(yearly.amount / 12),
              discountPercent: Math.max(
                0,
                Math.round((1 - yearly.amount / (monthly.amount * 12)) * 100),
              ),
            }
          : null,
      });
    }

    if (plans.length === 0) {
      throw this.noDisponible();
    }

    return { currency: currency === 'mxn' ? 'MXN' : 'USD', plans };
  }

  private refPara(
    plan: SellablePlan,
    currency: PriceCurrency,
    interval: BillingInterval,
  ): PriceRef | undefined {
    return this.catalog
      .all()
      .find(
        (ref) =>
          ref.plan === plan &&
          ref.currency === currency &&
          ref.interval === interval,
      );
  }

  private precio(
    ref: PriceRef | undefined,
    importes: ImportesValidados,
  ): PlanPriceDto | null {
    const amount = ref ? importes.get(ref.envVar) : undefined;
    if (amount === undefined) return null;
    return {
      priceId: ref.priceId,
      amount,
      display: formatDisplay(amount, ref.currency),
    };
  }

  private async cargarImportes(): Promise<ImportesValidados> {
    const ahora = Date.now();
    const enEspera =
      this.ultimoFalloAt !== null &&
      ahora - this.ultimoFalloAt < this.backoffMs;

    if (this.cache) {
      // Sin ronda ya en vuelo: cada visita colgaría su propio aviso de la misma
      // promesa y un solo fallo de Stripe se registraría una vez por visitante.
      if (
        ahora - this.cache.fetchedAt >= PlanCatalogService.CACHE_TTL_MS &&
        !enEspera &&
        !this.enVuelo
      ) {
        // En segundo plano: la visita no espera. El fallo ya lo registra
        // `refrescar`; aquí solo se evita el rechazo sin manejar.
        this.refrescar().catch(() =>
          this.logger.warn(
            'Se siguen sirviendo los precios de la última lectura buena: Stripe no respondió al refrescarlos.',
          ),
        );
      }
      return this.cache.importes;
    }

    if (enEspera) {
      throw this.noDisponible();
    }

    try {
      return await this.refrescar();
    } catch {
      throw this.noDisponible();
    }
  }

  /** Una sola ronda de lecturas a la vez, compartida por todas las visitas que la esperan. */
  private refrescar(): Promise<ImportesValidados> {
    if (!this.enVuelo) {
      this.enVuelo = this.leerDeStripe()
        .then((importes) => {
          this.cache = { importes, fetchedAt: Date.now() };
          this.ultimoFalloAt = null;
          return importes;
        })
        .catch((error: unknown) => {
          const status = (error as { statusCode?: number })?.statusCode;
          this.ultimoFalloAt = Date.now();
          this.backoffMs =
            status === 401 || status === 403
              ? PlanCatalogService.AUTH_FAILURE_BACKOFF_MS
              : PlanCatalogService.FAILURE_BACKOFF_MS;
          this.registrarFallo(error);
          throw error;
        })
        .finally(() => {
          this.enVuelo = null;
        });
    }
    return this.enVuelo;
  }

  private async leerDeStripe(): Promise<ImportesValidados> {
    const refs = this.catalog.all();
    const lecturas = await Promise.allSettled(
      refs.map((ref) => this.stripe.prices.retrieve(ref.priceId)),
    );

    const importes = new Map<string, number>();
    for (const [i, lectura] of lecturas.entries()) {
      const ref = refs[i];

      if (lectura.status === 'rejected') {
        const error = lectura.reason as { code?: string };
        // Un ID que Stripe no conoce es configuración, no una caída: se publica
        // el resto y ese precio queda como no configurado hasta la próxima ronda.
        if (error?.code === 'resource_missing') {
          this.logger.error(
            `CRITICAL: Stripe no reconoce el precio ${ref.priceId} de ${ref.envVar}; ` +
              `no se publica. Revisar la variable de entorno.`,
          );
          continue;
        }
        // Cualquier otro fallo invalida la ronda entera. Publicar a medias
        // dejaría la pestaña anual deshabilitada una hora por un error de red.
        throw lectura.reason;
      }

      const amount = this.validar(ref, lectura.value);
      if (amount !== null) {
        importes.set(ref.envVar, amount);
      }
    }

    return importes;
  }

  /**
   * Comprueba que el precio de Stripe vende lo que dice su variable de entorno.
   *
   * Un ID copiado en la variable equivocada —el mensual en la anual, el de USD en
   * la de MXN— publicaría un descuento o una moneda que el checkout no cobra.
   * Ante cualquier discrepancia el precio no se publica.
   */
  private validar(ref: PriceRef, price: Stripe.Price): number | null {
    const problemas: string[] = [];

    if (!price.active) problemas.push('inactivo');
    if (price.currency?.toLowerCase() !== ref.currency) {
      problemas.push(
        `moneda '${price.currency}' en lugar de '${ref.currency}'`,
      );
    }
    if (intervalFromStripe(price.recurring?.interval) !== ref.interval) {
      problemas.push(
        `periodicidad '${price.recurring?.interval ?? 'no recurrente'}' en lugar de '${ref.interval}'`,
      );
    }
    if (price.recurring && price.recurring.interval_count !== 1) {
      problemas.push(`interval_count ${price.recurring.interval_count}`);
    }
    if (typeof price.unit_amount !== 'number' || price.unit_amount <= 0) {
      problemas.push('sin unit_amount');
    }

    if (problemas.length > 0) {
      this.logger.error(
        `CRITICAL: el precio ${ref.priceId} de ${ref.envVar} no cuadra con su variable ` +
          `(${problemas.join(', ')}); no se publica.`,
      );
      return null;
    }

    return price.unit_amount;
  }

  private registrarFallo(error: unknown): void {
    const stripeError = error as { statusCode?: number; message?: string };
    const status = stripeError?.statusCode;

    if (status === 401 || status === 403) {
      // La key de producción es restringida: leer precios exige el permiso
      // «Products: read», y sin él esta ruta queda en 503 hasta que se conceda.
      this.logger.error(
        `CRITICAL: Stripe rechazó la lectura de precios (HTTP ${status}). ` +
          (status === 401
            ? 'La STRIPE_SECRET_KEY desplegada es inválida o fue revocada.'
            : 'La STRIPE_SECRET_KEY no tiene permiso de lectura de Products/Prices.') +
          ` Detalle: ${stripeError.message}`,
      );
      return;
    }

    this.logger.error(
      `No se pudieron leer los precios de Stripe: ${stripeError?.message ?? String(error)}`,
    );
  }

  private noDisponible(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Plan prices are temporarily unavailable. Please try again later.',
    );
  }
}

/**
 * `$99` en MXN y `US$5` en USD, como los pinta la página de precios. Los
 * decimales solo aparecen cuando el importe no es entero.
 */
export function formatDisplay(
  amountMinor: number,
  currency: PriceCurrency,
): string {
  const unidades = amountMinor / 100;
  const decimales = Number.isInteger(unidades) ? 0 : 2;
  const texto = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  }).format(unidades);

  return currency === 'mxn' ? `$${texto}` : `US$${texto}`;
}
