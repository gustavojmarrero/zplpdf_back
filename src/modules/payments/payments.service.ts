import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import {
  CheckoutResponseDto,
  PortalResponseDto,
} from './dto/create-checkout.dto.js';
import { GA4Service } from '../analytics/ga4.service.js';
import { ExchangeRateService } from '../admin/services/exchange-rate.service.js';
import { EmailService } from '../email/email.service.js';
import { BillingService } from '../billing/billing.service.js';
import {
  extractBillingPeriod,
  getSubscriptionIdFromInvoice,
  type BillingPeriod,
} from '../../common/utils/stripe-billing-period.util.js';
import type {
  StripeTransaction,
  SubscriptionEvent,
} from '../../common/interfaces/finance.interface.js';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import { PLAN_ORDER } from '../../common/interfaces/user.interface.js';
import type { PlanType, User } from '../../common/interfaces/user.interface.js';
import { randomUUID } from 'node:crypto';

type PaidPlanType = 'lite' | 'pro' | 'promax' | 'enterprise';
/** Planes de pago vendibles por checkout/upgrade (excluye enterprise, que es manual). */
type SellablePlan = 'lite' | 'pro' | 'promax';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private stripe: Stripe;
  private proPriceId: string;
  private proPriceIdMxn: string;
  private promaxPriceId: string;
  private promaxPriceIdMxn: string;
  private litePriceId: string;
  private litePriceIdMxn: string;
  private readonly MAX_RETRIES = 3;

  /**
   * Resuelve el periodo de la suscripción y deja constancia si no puede.
   *
   * El aviso importa: la versión anterior fallaba en silencio y por eso el
   * periodo llevaba meses sin escribirse sin que nada lo delatara.
   */
  private resolveBillingPeriod(
    subscription: Stripe.Subscription,
  ): BillingPeriod {
    const period = extractBillingPeriod(subscription);

    if (!period.start || !period.end) {
      this.logger.warn(
        `Subscription ${subscription.id} sin fechas de periodo en items.data[0]; no se actualiza el ciclo de facturación`,
      );
    }

    return period;
  }

  /**
   * Ejecuta una operación con reintentos
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        this.logger.error(
          `${operationName} failed (attempt ${attempt}/${this.MAX_RETRIES}): ${error.message}`,
        );
        if (attempt === this.MAX_RETRIES) {
          throw error;
        }
        // Exponential backoff: 1s, 2s, 4s
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
        );
      }
    }
    throw new Error(
      `${operationName} failed after ${this.MAX_RETRIES} attempts`,
    );
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly firestoreService: FirestoreService,
    private readonly ga4Service: GA4Service,
    private readonly exchangeRateService: ExchangeRateService,
    @Inject(forwardRef(() => EmailService))
    private readonly emailService: EmailService,
    private readonly billingService: BillingService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    const nodeEnv = this.configService.get<string>('NODE_ENV');

    if (!stripeSecretKey) {
      this.logger.warn(
        'Stripe secret key not configured. Payment features disabled.',
      );
      return;
    }

    // Validate test vs live key based on environment
    if (nodeEnv === 'production' && stripeSecretKey.startsWith('sk_test_')) {
      this.logger.error(
        'CRITICAL: Using Stripe TEST key in PRODUCTION environment!',
      );
      throw new Error(
        'FATAL: Using Stripe test key in production! Check STRIPE_SECRET_KEY configuration.',
      );
    }

    if (nodeEnv !== 'production' && stripeSecretKey.startsWith('sk_live_')) {
      this.logger.warn(
        'WARNING: Using Stripe LIVE key in non-production environment',
      );
    }

    this.stripe = new Stripe(stripeSecretKey);

    this.proPriceId = this.configService.get<string>('STRIPE_PRO_PRICE_ID');
    this.proPriceIdMxn = this.configService.get<string>(
      'STRIPE_PRO_PRICE_ID_MXN',
    );
    this.promaxPriceId = this.configService.get<string>(
      'STRIPE_PROMAX_PRICE_ID',
    );
    this.promaxPriceIdMxn = this.configService.get<string>(
      'STRIPE_PROMAX_PRICE_ID_MXN',
    );
    this.litePriceId = this.configService.get<string>('STRIPE_LITE_PRICE_ID');
    this.litePriceIdMxn = this.configService.get<string>(
      'STRIPE_LITE_PRICE_ID_MXN',
    );

    // Validate price IDs are configured
    if (!this.proPriceId) {
      this.logger.warn('STRIPE_PRO_PRICE_ID not configured');
    }
    if (!this.proPriceIdMxn) {
      this.logger.warn('STRIPE_PRO_PRICE_ID_MXN not configured');
    }
    if (!this.promaxPriceId) {
      this.logger.warn('STRIPE_PROMAX_PRICE_ID not configured');
    }
    if (!this.promaxPriceIdMxn) {
      this.logger.warn('STRIPE_PROMAX_PRICE_ID_MXN not configured');
    }
    if (!this.litePriceId) {
      this.logger.warn('STRIPE_LITE_PRICE_ID not configured');
    }
    if (!this.litePriceIdMxn) {
      this.logger.warn('STRIPE_LITE_PRICE_ID_MXN not configured');
    }
  }

  /**
   * Get plan type from Stripe price ID.
   *
   * Devuelve `null` si el price ID no está mapeado a ningún plan. NO hace fallback
   * a 'pro': un price ID desconocido es casi siempre un error de configuración
   * (ej. STRIPE_LITE_PRICE_ID sin definir), y asignar Pro por defecto regalaría
   * un plan superior. Los callers deben tratar `null` como condición de error.
   */
  private getPlanFromPriceId(priceId: string): PaidPlanType | null {
    if (priceId === this.proPriceId || priceId === this.proPriceIdMxn) {
      return 'pro';
    }
    if (priceId === this.promaxPriceId || priceId === this.promaxPriceIdMxn) {
      return 'promax';
    }
    if (priceId === this.litePriceId || priceId === this.litePriceIdMxn) {
      return 'lite';
    }
    this.logger.error(
      `CRITICAL: Unknown Stripe price ID '${priceId}' — not mapped to any plan. ` +
        `Check STRIPE_LITE/PRO/PROMAX_PRICE_ID[_MXN] configuration. Plan NOT assigned.`,
    );
    return null;
  }

  /**
   * Get price ID for a plan and country
   */
  private getPriceIdForPlan(plan: SellablePlan, country?: string): string {
    const isMexico = country === 'MX';
    if (plan === 'promax') {
      return isMexico ? this.promaxPriceIdMxn : this.promaxPriceId;
    }
    if (plan === 'lite') {
      return isMexico ? this.litePriceIdMxn : this.litePriceId;
    }
    return isMexico ? this.proPriceIdMxn : this.proPriceId;
  }

  /**
   * Rechaza el alta cuando ya hay un contrato vivo, con el motivo que toque.
   *
   * Siempre lanza. Está extraído porque lo necesitan dos caminos: el contrato que
   * ya estaba vivo al empezar, y el que se recuperó a mitad de la liquidación
   * —el cliente pagó desde el portal justo entonces—. Ese segundo camino es el
   * que faltaba: sin él se cancelaba una suscripción recién pagada y se le abría
   * un segundo cobro al cliente el mismo día.
   */
  private bloquearAltaSobreContratoVivo(
    viva: Stripe.Subscription,
    plan: SellablePlan,
  ): never {
    const currentPriceId = viva.items.data[0]?.price?.id;
    const currentPlan = currentPriceId
      ? this.getPlanFromPriceId(currentPriceId)
      : null;

    // If trying to buy the same plan, reject
    if (currentPlan === plan) {
      throw new BadRequestException(
        `You already have an active ${plan.toUpperCase()} subscription. Manage it from your account settings.`,
      );
    }

    // If moving UP between paid plans (lite→pro, lite→promax, pro→promax),
    // redirect to the upgrade endpoint to modify the existing subscription
    // with proration instead of creating a duplicate subscription.
    if (currentPlan && PLAN_ORDER[plan] > PLAN_ORDER[currentPlan]) {
      throw new BadRequestException(
        `Use the upgrade endpoint to upgrade from ${currentPlan.toUpperCase()} to ${plan.toUpperCase()}.`,
      );
    }

    // Any other case with an active subscription (downgrade, lateral move, or
    // an unrecognized current plan) must NOT create a second checkout, or Stripe
    // would create a duplicate subscription and the webhook would orphan the old
    // one. Block and direct the user to the customer portal to change/cancel first.
    throw new BadRequestException(
      `You already have an active subscription${currentPlan ? ` (${currentPlan.toUpperCase()})` : ''}. ` +
        `To downgrade or change your plan, manage it from your account settings (customer portal).`,
    );
  }

  async createCheckoutSession(
    userId: string,
    email: string,
    successUrl: string,
    cancelUrl: string,
    country?: string,
    plan: SellablePlan = 'pro',
  ): Promise<CheckoutResponseDto> {
    if (!this.stripe) {
      throw new BadRequestException('Payment system not configured');
    }

    // Select price based on plan and country
    const priceId = this.getPriceIdForPlan(plan, country);

    if (!priceId) {
      throw new BadRequestException(`${plan} price not configured`);
    }

    // Get or create Stripe customer
    let user = await this.firestoreService.getUserById(userId);

    // El contraste con Stripe va ANTES de mirar el plan del documento, y el orden
    // importa desde #65. El documento puede decir todavía `pro` mientras el
    // contrato está impagado —el webhook que lo degrada tarda en llegar, o se
    // perdió—, y comprobando primero el plan, el cliente al que acaban de cortarle
    // el PRO por impago no podría recontratar PRO: saldría rechazado por «ya estás
    // suscrito» sin que nadie llegase a liquidar el contrato muerto. Otro callejón
    // de la misma familia que el issue.
    if (user?.stripeSubscriptionId) {
      try {
        const existingSubscription = await this.stripe.subscriptions.retrieve(
          user.stripeSubscriptionId,
        );

        // Un contrato impagado ya no reserva el sitio: se liquida aquí mismo y
        // el checkout continúa. Es la salida que le faltaba al cliente de #65
        // —antes esta rama lo remitía al endpoint de upgrade, que lo rechazaba
        // por no estar `active`— y de paso evita el duplicado que se produciría
        // dejándolo pasar sin cancelar el anterior.
        if (
          PaymentsService.ESTADOS_IMPAGADOS.includes(
            existingSubscription.status,
          )
        ) {
          const liquidado = await this.liquidarContratoImpagadoAntesDelAlta(
            user,
            existingSubscription,
          );

          if (liquidado) {
            // La liquidación dejó el documento en Free; sin releer, la
            // comprobación de plan de más abajo seguiría viendo el plan muerto y
            // rechazaría el alta que acabamos de habilitar.
            user = (await this.firestoreService.getUserById(userId)) ?? user;
          } else {
            // El cliente pagó entre la lectura de arriba y la liquidación —desde
            // el portal, o con un reintento que entró—. El contrato ha vuelto a
            // la vida, así que se trata como tal: dejarlo pasar abriría un
            // segundo cobro sobre una renovación que acaba de saldar.
            this.bloquearAltaSobreContratoVivo(
              await this.stripe.subscriptions.retrieve(existingSubscription.id),
              plan,
            );
          }
        } else if (
          PaymentsService.ESTADOS_VIVOS.includes(existingSubscription.status)
        ) {
          this.bloquearAltaSobreContratoVivo(existingSubscription, plan);
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        // También sale el fallo de la liquidación. Este `catch` existe para
        // tolerar que la suscripción no exista en Stripe (típico al cambiar de
        // modo test/live), no para tragarse un contrato impagado que no se pudo
        // cerrar: tragándolo dejaría continuar el alta y el cliente acabaría con
        // dos suscripciones vivas, que es lo que la liquidación venía a impedir.
        if (error instanceof ServiceUnavailableException) throw error;
        // Subscription doesn't exist in Stripe (maybe switched test/live mode)
        this.logger.warn(
          `Could not verify subscription ${user.stripeSubscriptionId}: ${error.message}`,
        );
      }
    }

    // VALIDATION: Prevent duplicate subscriptions
    // Check if user already has the same plan
    if (user?.plan === plan) {
      throw new BadRequestException(
        `You are already subscribed to the ${plan.toUpperCase()} plan. Manage your subscription from your account settings.`,
      );
    }

    // VALIDATION: Check for any active subscription by customer ID (defense in depth)
    // This catches cases where user.stripeSubscriptionId is null but Stripe has active subs
    if (user?.stripeCustomerId) {
      try {
        const activeSubscriptions = await this.stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'active',
          limit: 5,
        });

        if (activeSubscriptions.data.length > 0) {
          const activeSub = activeSubscriptions.data[0];
          const activePriceId = activeSub.items.data[0]?.price?.id;
          const activePlan = activePriceId
            ? this.getPlanFromPriceId(activePriceId)
            : null;

          // If user trying to buy the same plan they already have active in Stripe
          if (activePlan === plan) {
            this.logger.warn(
              `User ${userId} has active Stripe subscription ${activeSub.id} (${activePlan}) ` +
                `but tried to create checkout for ${plan}. Blocking duplicate.`,
            );
            throw new BadRequestException(
              `You already have an active ${plan.toUpperCase()} subscription (${activeSub.id}). ` +
                `Manage it from your account settings.`,
            );
          }

          // An active subscription exists for a DIFFERENT plan. Creating a new checkout
          // would produce a duplicate subscription, so block here too. Upgrades must go
          // through the upgrade endpoint; downgrades/lateral moves via the customer portal.
          if (activePlan && PLAN_ORDER[plan] > PLAN_ORDER[activePlan]) {
            throw new BadRequestException(
              `Use the upgrade endpoint to upgrade from ${activePlan.toUpperCase()} to ${plan.toUpperCase()}.`,
            );
          }
          if (activeSubscriptions.data.length > 1) {
            this.logger.warn(
              `User ${userId} has ${activeSubscriptions.data.length} active subscriptions in Stripe: ` +
                activeSubscriptions.data.map((s) => s.id).join(', '),
            );
          }
          this.logger.warn(
            `User ${userId} has active Stripe subscription ${activeSub.id} (${activePlan ?? 'unknown'}) ` +
              `but tried to create checkout for ${plan}. Blocking to avoid duplicate.`,
          );
          throw new BadRequestException(
            `You already have an active subscription${activePlan ? ` (${activePlan.toUpperCase()})` : ''} (${activeSub.id}). ` +
              `To downgrade or change your plan, manage it from your account settings (customer portal).`,
          );
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        this.logger.error(
          `Failed to list subscriptions for customer ${user.stripeCustomerId}: ${error.message}`,
        );
        // Don't block checkout if we can't verify - log and continue
      }
    }

    let customerId = user?.stripeCustomerId;

    // Verify customer exists in current Stripe mode (test/live)
    if (customerId) {
      try {
        await this.stripe.customers.retrieve(customerId);
      } catch {
        // Customer doesn't exist in current mode, create new one
        this.logger.warn(
          `Customer ${customerId} not found in current Stripe mode, creating new one`,
        );
        customerId = null;
      }
    }

    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email,
        metadata: {
          firebaseUid: userId,
        },
      });
      customerId = customer.id;

      // Save customer ID to user
      await this.firestoreService.updateUser(userId, {
        stripeCustomerId: customerId,
      });
    }

    // Los datos fiscales tienen que estar en el customer ANTES de abrir el
    // checkout. Stripe copia el nombre, el domicilio y los tax IDs a la factura
    // en el momento de finalizarla —lo hace durante el propio checkout— y ya no
    // vuelve a tocarlos: propagarlos al recibir `checkout.session.completed`
    // llegaría tarde y el primer PDF saldría sin ellos.
    //
    // En modo estricto, para que el fallo detenga el checkout. Es preferible que
    // el usuario reintente el pago a emitirle una factura fiscalmente incompleta
    // que después no hay forma de corregir. Solo afecta a quien tiene perfil
    // fiscal cargado: sin él la sincronización no hace nada y no puede fallar.
    try {
      await this.billingService.syncTaxProfileToStripe(userId, {
        throwOnError: true,
      });
    } catch (error) {
      this.logger.error(
        `No se pudo propagar el perfil fiscal de ${userId} antes del checkout: ${error.message}`,
      );
      throw new ServiceUnavailableException(
        'No se pudieron sincronizar tus datos de facturación. Inténtalo de nuevo en unos momentos.',
      );
    }

    // Create checkout session
    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        firebaseUid: userId,
      },
    });

    this.logger.log(`Checkout session created for user: ${userId}`);

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  }

  async createPortalSession(
    userId: string,
    returnUrl: string,
  ): Promise<PortalResponseDto> {
    if (!this.stripe) {
      throw new BadRequestException('Payment system not configured');
    }

    const user = await this.firestoreService.getUserById(userId);

    if (!user?.stripeCustomerId) {
      throw new BadRequestException('No subscription found for this user');
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });

    return {
      portalUrl: session.url,
    };
  }

  /**
   * Traduce un error de la API de Stripe en una excepción HTTP con mensaje accionable.
   *
   * Un 401/403 es un fallo de CONFIGURACIÓN (API key inválida, o restricted key sin el
   * scope necesario), no un error del usuario: se registra como CRITICAL para que salte
   * en los logs y se devuelve como 503. Antes estos errores escapaban sin capturar y el
   * usuario recibía un 500 opaco, así que reintentaba una y otra vez sin saber que el
   * problema no estaba de su lado.
   */
  private throwStripeApiError(
    error: unknown,
    operation: string,
    context: string,
    /**
     * Aclaración que se añade al mensaje del usuario. Sirve para decirle qué ha
     * quedado sin cambiar: tras un cobro rechazado, lo primero que necesita
     * saber es que su plan sigue siendo el de antes.
     */
    userSuffix = '',
  ): never {
    const stripeError = error as {
      statusCode?: number;
      type?: string;
      message?: string;
    };
    const status = stripeError.statusCode;

    if (status === 401 || status === 403) {
      // 401 y 403 se arreglan en sitios distintos: un 401 es una credencial
      // inválida/revocada/mal desplegada (hay que rotar o corregir la key), un 403
      // es una key válida sin el scope (hay que editar sus permisos). Dar el consejo
      // equivocado durante una caída manda al equipo a buscar donde no es.
      const action =
        status === 401
          ? `La STRIPE_SECRET_KEY desplegada es inválida o fue revocada: validar o rotar la clave.`
          : `La STRIPE_SECRET_KEY no tiene permisos para esta operación: revisar los scopes ` +
            `de la API key en el dashboard de Stripe.`;
      this.logger.error(
        `CRITICAL: ${operation} rechazado por Stripe (HTTP ${status}) — ${context}. ` +
          `${action} Detalle: ${stripeError.message}`,
      );
      throw new ServiceUnavailableException(
        'We could not process your plan change right now due to a configuration issue on our side. ' +
          'Our team has been notified — please contact support@zplpdf.com.' +
          userSuffix,
      );
    }

    if (stripeError.type === 'StripeCardError') {
      this.logger.warn(
        `${operation} falló por la tarjeta — ${context}. Detalle: ${stripeError.message}`,
      );
      throw new BadRequestException(
        (stripeError.message ||
          'Your card was declined. Please update your payment method and try again.') +
          userSuffix,
      );
    }

    this.logger.error(
      `${operation} falló — ${context}. Detalle: ${stripeError.message}`,
    );
    throw new ServiceUnavailableException(
      'We could not process your plan change right now. Please try again in a few minutes ' +
        'or contact support@zplpdf.com.' +
        userSuffix,
    );
  }

  /**
   * Mensaje para un upgrade bloqueado por el estado de la suscripción.
   *
   * La acción que resuelve el bloqueo depende del estado. En los de cobro
   * (`past_due`, `unpaid`) la salida ya no es cambiar la tarjeta: desde #65 el
   * contrato impagado se cancela, así que no queda suscripción que rescatar y lo
   * que corresponde es contratar de nuevo —el propio checkout liquida los restos—.
   * Si la suscripción ya terminó, igual; en el resto de estados no hay nada que el
   * cliente pueda arreglar por su cuenta.
   *
   * Este mensaje cierra el callejón de #65 por el otro extremo: el checkout ya no
   * remite aquí a nadie en `past_due`, y quien llegue igualmente sale hacia el
   * checkout en vez de quedarse sin instrucción que seguir.
   */
  private inactiveSubscriptionMessage(status: string): string {
    const base = `Your subscription is not active (status: ${status}).`;

    if (
      PaymentsService.ESTADOS_IMPAGADOS.includes(status) ||
      status === 'canceled' ||
      status === 'incomplete_expired'
    ) {
      return `${base} Please subscribe again to get the plan you need.`;
    }

    return `${base} Manage your subscription from your account settings before upgrading.`;
  }

  /** Stripe descarta las claves de idempotencia a las 24 h; no tiene sentido conservarlas más. */
  private static readonly IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Lease del upgrade en curso: durante cuánto se rechaza otro hacia un destino
   * distinto sin haber recibido señal de que el primero terminó (issue #73).
   *
   * Dimensionado sobre el peor caso REAL de la única llamada que queda dentro
   * del candado, `subscriptions.update`, con el SDK en sus valores por defecto:
   *
   *   3 intentos × 80 s de timeout        = 240 s
   * + 2 esperas × 60 s (`MAX_RETRY_AFTER_WAIT`, que el SDK respeta cuando
   *   Stripe manda `Retry-After`)         = 120 s
   *                                       -------
   *                                         360 s
   *
   * Siete minutos (420 s) dejan un minuto de margen. El backoff de red normal
   * tiene tope de 5 s, así que solo se acerca a esa cota una llamada que además
   * choque con limitación de tasa.
   *
   * El lease casi nunca llega a agotarse: todos los desenlaces definitivos
   * liberan la clave —incluido el 3DS, que la suelta al devolver el enlace de
   * pago—, así que solo cuenta cuando la petición sigue viva de verdad, murió
   * sin liberar, o terminó en el error indeterminado, donde la clave se conserva
   * a propósito. Tampoco puede ser el TTL de 24 h: eso dejaría al cliente sin
   * poder cambiar de plan durante un día por un intento que quedó a medias.
   */
  private static readonly UPGRADE_LEASE_MS = 7 * 60 * 1000;

  /**
   * Lease del mutex de sincronización de la suscripción (issue #77).
   *
   * Lo dimensiona el tramo más largo ENTRE RENOVACIONES, no el ciclo completo.
   * El más largo es el del upgrade: la relectura que revalida el estado vigente
   * y el `subscriptions.update`, a 360 s de peor caso cada una con el SDK en sus
   * valores por defecto (3 × 80 s de timeout + 2 × 60 s de `Retry-After`). Son
   * 720 s; trece minutos dejan un minuto de margen.
   *
   * La reconciliación añade una tercera llamada, pero renueva el lease antes de
   * hacerla: cubrir las tres de golpe exigiría casi veinte minutos, y esa sería
   * la ventana durante la que un proceso muerto bloquearía al usuario. El ciclo
   * del webhook hace una sola llamada y va sobrado.
   *
   * Que sea holgado importa poco en la práctica: el `finally` lo libera, así que
   * solo llega a contar cuando el proceso muere con el lease tomado. Y quedarse
   * corto ya no corrompe nada —el fencing token descarta la escritura del
   * titular relevado—, pero sí obligaría al cliente a reintentar, así que más
   * vale que sobre.
   */
  private static readonly SUBSCRIPTION_SYNC_LEASE_MS = 13 * 60 * 1000;

  /**
   * Clave de idempotencia del intento de upgrade, estable entre reintentos.
   *
   * No se deriva del reloj: una cubeta temporal (`Date.now() / 60000`) parte dos
   * llamadas separadas por segundos si caen a ambos lados del cambio de minuto,
   * que es justo el caso que hay que cubrir — el reintento inmediato tras un
   * timeout. Se persiste en el usuario y se reutiliza mientras el intento siga
   * vivo, de modo que ese reintento llegue a Stripe con la misma clave y no
   * genere un segundo cargo.
   */
  private async getUpgradeIdempotencyKey(
    userId: string,
    targetPlan: PlanType,
    subscriptionId: string,
  ): Promise<string> {
    // La adquisición es transaccional: dos upgrades simultáneos no pueden
    // acabar con claves distintas y, por tanto, con dos mutaciones en Stripe.
    const result = await this.firestoreService.acquireUpgradeIdempotency(
      userId,
      {
        key: `upgrade_${userId}_${randomUUID()}`,
        targetPlan,
        subscriptionId,
      },
      PaymentsService.IDEMPOTENCY_TTL_MS,
      PaymentsService.UPGRADE_LEASE_MS,
    );

    // Dos destinos distintos no pueden compartir clave, así que serializarlos es
    // lo único que impide que Stripe procese ambos. Se rechaza el segundo en vez
    // de encolarlo: el primero puede acabar en pago pendiente o rechazo, y
    // entonces el cliente ya no querrá el mismo cambio.
    if (result.status === 'conflict') {
      this.logger.warn(
        `Upgrade a ${targetPlan} rechazado para ${userId}: hay otro a ` +
          `${result.targetPlan} todavía en curso sobre ${subscriptionId}.`,
      );
      throw new ConflictException(
        `A plan change to ${result.targetPlan.toUpperCase()} is already in progress. ` +
          `Please wait for it to finish and check your subscription before requesting ` +
          `a different plan.`,
      );
    }

    return result.key;
  }

  /**
   * Libera la clave tras un resultado definitivo (éxito, rechazo de tarjeta,
   * pago pendiente...). Solo se conserva ante errores indeterminados, que son
   * los que el cliente debe reintentar con la MISMA clave.
   *
   * Se libera comparando: si otro intento posterior ya adquirió una clave
   * distinta, borrarla lo dejaría sin protección frente a duplicados.
   */
  private async clearUpgradeIdempotencyKey(
    userId: string,
    key: string,
  ): Promise<void> {
    try {
      await this.firestoreService.releaseUpgradeIdempotency(userId, key);
    } catch (error) {
      // No es motivo para tumbar un upgrade que ya se resolvió: como mucho, el
      // siguiente intento reusa una clave que Stripe descartará en 24 h.
      this.logger.warn(
        `No se pudo limpiar la clave de idempotencia de ${userId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * El cambio de plan quedó en `pending_update`: Stripe lo aplicará solo cuando
   * el cobro se complete o el cliente autentique (3DS). El plan NO se toca.
   *
   * Es importante darle el enlace de la factura y no invitarle a reintentar:
   * lanzar otro update reemplazaría este pending update y anularía su factura,
   * dejándole sin la vía de pago que ya tenía abierta.
   */
  private throwPendingPaymentError(
    subscription: Stripe.Subscription,
    context: string,
  ): never {
    const invoice = subscription.latest_invoice as Stripe.Invoice | null;
    const payUrl = invoice?.hosted_invoice_url;

    this.logger.warn(
      `Upgrade pendiente de pago: el cambio quedó en pending_update — ${context}. ` +
        `Plan sin cambiar. Factura: ${invoice?.id ?? 'desconocida'}.`,
    );

    throw new BadRequestException(
      `Your plan has not been changed yet: the payment needs to be completed or authenticated. ` +
        (payUrl
          ? `Complete it here and the change will apply automatically: ${payUrl}`
          : `Please check your payment method from your account settings and try again.`),
    );
  }

  /**
   * Reconcilia el estado real tras un error de Stripe *indeterminado*.
   *
   * `StripeConnectionError` y `StripeAPIError` no significan "no se hizo nada":
   * Stripe puede haber aplicado y cobrado el cambio y haberse perdido solo la
   * respuesta. Decirle al cliente "tu plan no ha cambiado" sería falso y le
   * empujaría a reintentar sobre un cargo ya hecho.
   *
   * Devuelve el resultado del upgrade si al releer la suscripción resulta que sí
   * se aplicó; `null` si se confirma que no, para que el caller trate el error
   * con normalidad.
   */
  private async reconcileIndeterminateUpgrade(
    error: unknown,
    userId: string,
    targetPlan: 'pro' | 'promax',
    subscriptionId: string,
    expectedPriceId: string,
    context: string,
    lockToken: string,
    idempotencyKey: string,
  ): Promise<{ success: boolean; message: string } | null> {
    const type = (error as { type?: string }).type;
    if (type !== 'StripeConnectionError' && type !== 'StripeAPIError') {
      return null;
    }

    this.logger.warn(
      `Error indeterminado de Stripe (${type}) — ${context}. Releyendo la suscripción ` +
        `para saber si el cambio llegó a aplicarse.`,
    );

    // Este camino añade una tercera llamada a Stripe dentro del mismo ciclo, y
    // las dos anteriores ya pueden haber consumido casi todo el lease. Renovarlo
    // aquí evita dimensionarlo por las tres de golpe —una ventana que dejaría al
    // usuario bloqueado casi veinte minutos si el proceso muriera— y evita que
    // el fencing acabe descartando una escritura que sí es legítima.
    let renovado = false;
    try {
      renovado = await this.firestoreService.renewSubscriptionSyncLock(
        userId,
        lockToken,
      );
    } catch (renewError) {
      // Escapar aquí daría un 500 genérico, y venimos de un update que PUEDE
      // haber cobrado: el contrato de este camino es pedir que se revise la
      // facturación antes de reintentar, no un error opaco.
      this.logger.error(
        `CRITICAL: no se pudo renovar el lease para reconciliar — ${context}. ` +
          `Detalle: ${(renewError as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'We could not confirm whether your plan change went through. Please check your billing ' +
          'settings before trying again, or contact support@zplpdf.com.',
      );
    }

    if (!renovado) {
      // Ya nos relevaron: la escritura se descartaría igualmente, y quien tenga
      // el ciclo ahora leerá el estado real. Se avisa sin afirmar nada.
      this.logger.error(
        `CRITICAL: no se pudo reconciliar el upgrade porque el lease ya no es ` +
          `nuestro — ${context}. Revisar la suscripción en Stripe a mano.`,
      );
      throw new ServiceUnavailableException(
        'We could not confirm whether your plan change went through. Please check your billing ' +
          'settings before trying again, or contact support@zplpdf.com.',
      );
    }

    let current: Stripe.Subscription;
    try {
      current = await this.stripe.subscriptions.retrieve(subscriptionId, {
        // Necesario para poder devolver el enlace de pago si resulta que la
        // petición perdida sí llegó a dejar un pending update.
        expand: ['latest_invoice'],
      });
    } catch (retrieveError) {
      // Sin poder leer el estado no se puede afirmar nada en ninguna dirección.
      this.logger.error(
        `CRITICAL: no se pudo reconciliar el upgrade tras un error indeterminado — ${context}. ` +
          `Revisar la suscripción en Stripe a mano. Detalle: ${(retrieveError as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'We could not confirm whether your plan change went through. Please check your billing ' +
          'settings before trying again, or contact support@zplpdf.com.',
      );
    }

    // Instante de la lectura que respalda lo que se va a escribir, por el mismo
    // motivo que en el resto del flujo: ordena esta escritura frente a las del
    // webhook (issue #74).
    const readAt = new Date();

    // Tercer resultado, ni aplicado ni fallido: la petición que se perdió sí
    // llegó a crear un pending update. Tratarlo como "no aplicado" devolvería un
    // error genérico y, peor, invitaría a reintentar — y un update nuevo
    // reemplaza el pending update existente y anula su factura, dejando al
    // cliente sin el enlace con el que ya podía pagar o autenticar.
    if (current.pending_update) {
      // Definitivo, igual que en el camino principal: hay una factura esperando.
      // Conservar la clave haría que un intento posterior —tras expirar el
      // pending, dentro de las 24 h de TTL— recibiera de Stripe la respuesta
      // cacheada del primero, que ofrece una factura ya anulada.
      await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);
      this.throwPendingPaymentError(current, context);
    }

    // Mismo criterio que autorizó el cambio y que lo confirma en el camino
    // principal: si `trialing` basta para aplicar el upgrade, tiene que bastar
    // para reconocerlo aplicado. Comparando contra `active` a secas, un upgrade
    // hecho durante una prueba se daría por no aplicado justo aquí —en el camino
    // que existe para reparar el desenlace indeterminado— y el cliente quedaría
    // con el precio nuevo en Stripe y el plan viejo en el producto, sin nada que
    // lo corrigiera después.
    const applied =
      PaymentsService.ESTADOS_MODIFICABLES.includes(current.status) &&
      current.items.data.some((item) => item.price?.id === expectedPriceId);

    if (!applied) {
      return null;
    }

    // El cambio sí se aplicó: sincronizamos Firestore para no dejar al cliente
    // pagando un plan que el producto no le reconoce.
    //
    // Se captura el RECHAZO además del `false`: si Firestore cae aquí, el cobro
    // ya está confirmado y dejar escapar la excepción daría un 500 genérico
    // sobre un cargo real. Los dos desenlaces son el mismo para el cliente.
    let persisted = false;
    let falloAlEscribir = false;
    try {
      persisted = await this.firestoreService.updateUserSubscriptionState(
        userId,
        { plan: targetPlan },
        readAt,
        lockToken,
      );
    } catch (persistError) {
      falloAlEscribir = true;
      this.logger.error(
        `No se pudo escribir el plan reconciliado — ${context}. ` +
          `Detalle: ${(persistError as Error).message}`,
      );
    }

    if (!persisted) {
      // Desenlace definitivo con cobro hecho: la clave sale de circulación o
      // seguiría marcando un intento vivo y bloquearía otros destinos durante
      // todo el lease, pese a que este ya terminó.
      await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);
      this.throwUnsyncedUpgradeError(
        targetPlan,
        context,
        falloAlEscribir ? 'fallo al escribir en Firestore' : 'relevo del lease',
      );
    }

    this.logger.log(
      `Upgrade reconciliado tras error indeterminado: el cambio sí se aplicó — ${context}.`,
    );

    return {
      success: true,
      message: `Successfully upgraded to ${targetPlan.toUpperCase()}. Proration has been applied.`,
    };
  }

  /**
   * El cambio se aplicó y se cobró en Stripe, pero la escritura del plan se
   * descartó: este ciclo se demoró más que el lease y otro lo relevó.
   *
   * NO se puede responder éxito —el producto seguiría sin reconocer el plan que
   * el cliente acaba de pagar— ni repetir la mutación, que ya está hecha. Se
   * avisa de que el cobro pasó y que el plan tardará un momento: el webhook
   * `customer.subscription.updated` llega detrás y sincroniza bajo su propio
   * ciclo, que es el mecanismo de reparación natural.
   */
  private throwUnsyncedUpgradeError(
    targetPlan: string,
    context: string,
    causa: 'relevo del lease' | 'fallo al escribir en Firestore',
  ): never {
    // La causa se pasa en lugar de asumirse: a este punto se llega tanto por
    // fencing como por una caída de Firestore, y dar por buena una de las dos
    // en el log dejaría a quien atienda el incidente —uno con dinero de por
    // medio— persiguiendo un relevo que quizá no ocurrió.
    this.logger.error(
      `CRITICAL: el upgrade a ${targetPlan} se aplicó en Stripe pero la escritura ` +
        `del plan no se confirmó (${causa}) — ${context}. Firestore queda ` +
        `pendiente de que lo sincronice el webhook.`,
    );
    // Con código propio y `paymentProcessed`, porque el status HTTP no
    // distingue: este endpoint devuelve 503 también ANTES de cobrar —si falla la
    // sincronización fiscal— y cuando la reconciliación no logra averiguar si
    // hubo cargo. Un cliente que dedujera "cobrado" del 503 a secas afirmaría un
    // cobro inexistente en dos de los tres casos.
    throw new ServiceUnavailableException({
      error: ErrorCodes.UPGRADE_APPLIED_SYNC_PENDING,
      message:
        `Your payment for ${targetPlan.toUpperCase()} went through, but confirming it is ` +
        `taking longer than usual. Your plan will be available shortly — please refresh ` +
        `in a moment before trying again.`,
      data: { paymentProcessed: true, targetPlan },
    });
  }

  /**
   * Upgrade subscription from one paid plan to another (e.g., PRO → PRO MAX)
   * Stripe handles proration automatically
   */
  async upgradeSubscription(
    userId: string,
    targetPlan: 'pro' | 'promax',
  ): Promise<{ success: boolean; message: string }> {
    if (!this.stripe) {
      throw new BadRequestException('Payment system not configured');
    }

    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (!user.stripeSubscriptionId) {
      throw new BadRequestException(
        'No active subscription to upgrade. Please subscribe first.',
      );
    }

    // Solo se permite subir a un plan ESTRICTAMENTE superior (lite→pro, lite→promax, pro→promax).
    if (PLAN_ORDER[targetPlan] <= PLAN_ORDER[user.plan]) {
      throw new BadRequestException(
        `Cannot upgrade from ${user.plan.toUpperCase()} to ${targetPlan.toUpperCase()}.`,
      );
    }

    const upgradeContext = `user ${userId} (${user.plan} → ${targetPlan}, sub ${user.stripeSubscriptionId})`;

    // Get current subscription to find the item ID
    let subscription: Stripe.Subscription;
    try {
      subscription = await this.stripe.subscriptions.retrieve(
        user.stripeSubscriptionId,
        // Para poder devolver la factura del cambio pendiente, si lo hay.
        { expand: ['latest_invoice'] },
      );
    } catch (error) {
      this.throwStripeApiError(error, 'subscriptions.retrieve', upgradeContext);
    }

    // Ya hay un cambio esperando pago: se devuelve ESA factura en lugar de
    // lanzar otro update. Un update nuevo reemplazaría el pending update y
    // anularía su factura, invalidando el enlace que ya se le había dado al
    // cliente — quedaría persiguiendo una URL muerta.
    if (subscription.pending_update) {
      this.throwPendingPaymentError(subscription, upgradeContext);
    }

    if (!PaymentsService.ESTADOS_MODIFICABLES.includes(subscription.status)) {
      this.logger.warn(
        `Upgrade bloqueado: la suscripción está en estado '${subscription.status}' — ${upgradeContext}`,
      );
      throw new BadRequestException(
        this.inactiveSubscriptionMessage(subscription.status),
      );
    }

    const subscriptionItemId = subscription.items.data[0]?.id;
    if (!subscriptionItemId) {
      throw new BadRequestException('Could not find subscription item');
    }

    // Get the new price ID based on user's country
    const newPriceId = this.getPriceIdForPlan(targetPlan, user.country);

    if (!newPriceId) {
      throw new BadRequestException(
        `${targetPlan.toUpperCase()} price not configured`,
      );
    }

    // `always_invoice` emite y cobra la factura de la proración dentro del
    // propio update, y Stripe congela en ella los datos fiscales del customer al
    // finalizarla. Igual que en el checkout, hay que propagarlos antes y en modo
    // estricto: si el guardado del perfil no llegó a Stripe en su momento, esta
    // factura saldría con datos viejos o sin ellos, y ya no habría forma de
    // corregirla.
    try {
      await this.billingService.syncTaxProfileToStripe(userId, {
        throwOnError: true,
      });
    } catch (error) {
      this.logger.error(
        `No se pudo propagar el perfil fiscal de ${userId} antes del upgrade: ${error.message}`,
      );
      throw new ServiceUnavailableException(
        'No se pudieron sincronizar tus datos de facturación. Inténtalo de nuevo en unos momentos.',
      );
    }

    // El upgrade entra en el MISMO mutex que el webhook: los dos observan el
    // estado en Stripe y escriben el plan, así que serializar solo los webhooks
    // dejaba abierta la carrera cruzada. Un webhook podía leer PRO, quedarse su
    // respuesta en tránsito mientras el upgrade confirmaba PROMAX, y al llegar
    // sellar más fresco y revertirlo.
    //
    // Va después de la sincronización fiscal por lo mismo que la clave: el sync
    // suma tres llamadas a Stripe y meterlas dentro haría el peor caso cuatro
    // veces mayor, imposible de cubrir con un lease razonable.
    return this.withSubscriptionSyncLock(
      userId,
      async (lockToken) => {
        // Revalidación DENTRO del lease. El plan se validó antes del sync
        // fiscal, y en ese hueco otro cambio pudo completarse: sin releer, un
        // lite→pro demorado entraría después de un lite→promax ya aplicado y
        // BAJARÍA la suscripción, violando la garantía de upgrade estricto.
        const fresh = await this.firestoreService.getUserById(userId);

        if (!fresh) {
          throw new BadRequestException('User not found');
        }

        if (fresh.stripeSubscriptionId !== user.stripeSubscriptionId) {
          this.logger.warn(
            `Upgrade abortado: la suscripción cambió mientras se preparaba — ` +
              `${upgradeContext}.`,
          );
          throw new ConflictException(
            'Your subscription changed while this request was being prepared. ' +
              'Please review your plan and try again.',
          );
        }

        if (PLAN_ORDER[targetPlan] <= PLAN_ORDER[fresh.plan]) {
          this.logger.warn(
            `Upgrade abortado: el plan pasó a ${fresh.plan} mientras se ` +
              `preparaba — ${upgradeContext}.`,
          );
          throw new BadRequestException(
            `Cannot upgrade from ${fresh.plan.toUpperCase()} to ${targetPlan.toUpperCase()}.`,
          );
        }

        // Firestore no basta: refleja lo que los webhooks han alcanzado a
        // escribir, no lo que Stripe tiene AHORA. Si otro upgrade dejó un
        // `pending_update` esperando pago, el plan en Firestore sigue igual
        // —ese camino no lo toca— y sin releer de Stripe lanzaríamos un update
        // que reemplaza ese pending update, anula su factura y emite otra,
        // dejando al cliente con el enlace de pago que ya tenía apuntando a una
        // factura muerta.
        let vigente: Stripe.Subscription;
        let vigenteReadAt: Date;
        try {
          vigente = await this.stripe.subscriptions.retrieve(
            user.stripeSubscriptionId,
            { expand: ['latest_invoice'] },
          );
          vigenteReadAt = new Date();
        } catch (error) {
          this.throwStripeApiError(
            error,
            'subscriptions.retrieve',
            upgradeContext,
          );
        }

        if (vigente.pending_update) {
          this.throwPendingPaymentError(vigente, upgradeContext);
        }

        if (!PaymentsService.ESTADOS_MODIFICABLES.includes(vigente.status)) {
          this.logger.warn(
            `Upgrade bloqueado: la suscripción pasó a '${vigente.status}' ` +
              `mientras se preparaba — ${upgradeContext}`,
          );
          throw new BadRequestException(
            this.inactiveSubscriptionMessage(vigente.status),
          );
        }

        // El plan efectivo lo dicta el precio que Stripe tiene puesto, no el
        // documento: es la comprobación que de verdad impide bajar de plan.
        const vigenteItem = vigente.items.data[0];

        if (!vigenteItem?.id) {
          throw new BadRequestException('Could not find subscription item');
        }

        const planVigente = vigenteItem.price?.id
          ? this.getPlanFromPriceId(vigenteItem.price.id)
          : null;

        // Falla cerrado: sin saber de qué plan se parte no se puede afirmar que
        // esto sea una subida, y facturar a ciegas es peor que rechazar. Es el
        // mismo caso de configuración que el webhook trata como CRITICAL sin
        // tocar el plan; `getPlanFromPriceId` ya lo registró.
        if (!planVigente) {
          this.logger.error(
            `CRITICAL: upgrade abortado por no poder resolver el plan del precio ` +
              `vigente '${vigenteItem.price?.id ?? 'sin precio'}' — ${upgradeContext}. ` +
              `Revisar STRIPE_*_PRICE_ID.`,
          );
          throw new ServiceUnavailableException(
            'We could not verify your current plan. Nothing was charged. ' +
              'Please try again later or contact support@zplpdf.com.',
          );
        }

        // Recuperación idempotente: un intento anterior pudo aplicar y cobrar el
        // target en Stripe, perder su respuesta y fallar también al reconciliar.
        // Firestore seguiría con el plan inferior, así que rechazar aquí como
        // target→target dejaría al cliente pagando sin entitlement y cada
        // reintento repetiría el mismo rechazo.
        if (
          planVigente === targetPlan &&
          PLAN_ORDER[fresh.plan] < PLAN_ORDER[targetPlan]
        ) {
          let persisted = false;
          let falloAlEscribir = false;
          try {
            persisted = await this.firestoreService.updateUserSubscriptionState(
              userId,
              { plan: targetPlan },
              vigenteReadAt,
              lockToken,
            );
          } catch (persistError) {
            falloAlEscribir = true;
            this.logger.error(
              `No se pudo sincronizar el upgrade ya aplicado — ${upgradeContext}. ` +
                `Detalle: ${(persistError as Error).message}`,
            );
          }

          // Solo corresponde al intento recuperado si coinciden contrato y
          // destino. El compare-and-delete de Firestore protege además una clave
          // posterior que pudiera haber reemplazado a esta lectura.
          const recoveredIdempotency = fresh.upgradeIdempotency;
          if (
            recoveredIdempotency?.targetPlan === targetPlan &&
            recoveredIdempotency.subscriptionId === user.stripeSubscriptionId
          ) {
            await this.clearUpgradeIdempotencyKey(
              userId,
              recoveredIdempotency.key,
            );
          }

          if (!persisted) {
            this.throwUnsyncedUpgradeError(
              targetPlan,
              upgradeContext,
              falloAlEscribir
                ? 'fallo al escribir en Firestore'
                : 'relevo del lease',
            );
          }

          this.logger.log(
            `Upgrade a ${targetPlan} ya aplicado en Stripe sincronizado de forma ` +
              `idempotente — ${upgradeContext}.`,
          );

          return {
            success: true,
            message: `Successfully upgraded to ${targetPlan.toUpperCase()}. Proration has been applied.`,
          };
        }

        if (PLAN_ORDER[targetPlan] <= PLAN_ORDER[planVigente]) {
          this.logger.warn(
            `Upgrade abortado: Stripe ya tiene la suscripción en ${planVigente} ` +
              `— ${upgradeContext}.`,
          );
          throw new BadRequestException(
            `Cannot upgrade from ${planVigente.toUpperCase()} to ${targetPlan.toUpperCase()}.`,
          );
        }

        return this.applyUpgrade({
          userId,
          user,
          targetPlan,
          // El item vigente, no el del snapshot previo al sync fiscal.
          subscriptionItemId: vigenteItem.id,
          newPriceId,
          upgradeContext,
          lockToken,
        });
      },
      'el cambio de plan',
    );
  }

  /**
   * Ejecuta la mutación en Stripe y la escritura del plan. Se llama SIEMPRE
   * dentro del mutex de sincronización, con el plan ya revalidado.
   */
  private async applyUpgrade({
    userId,
    user,
    targetPlan,
    subscriptionItemId,
    newPriceId,
    upgradeContext,
    lockToken,
  }: {
    userId: string;
    user: User;
    targetPlan: 'pro' | 'promax';
    subscriptionItemId: string;
    newPriceId: string;
    upgradeContext: string;
    lockToken: string;
  }): Promise<{ success: boolean; message: string }> {
    // La clave se toma justo antes de la única llamada que mueve dinero: así un
    // fallo previo no retiene una clave que nadie liberará.
    const idempotencyKey = await this.getUpgradeIdempotencyKey(
      userId,
      targetPlan,
      user.stripeSubscriptionId,
    );

    // Update subscription with proration
    let updatedSubscription: Stripe.Subscription;
    try {
      updatedSubscription = await this.stripe.subscriptions.update(
        user.stripeSubscriptionId,
        {
          items: [
            {
              id: subscriptionItemId,
              price: newPriceId,
            },
          ],
          proration_behavior: 'always_invoice', // Charge/credit immediately
          // Con el comportamiento por defecto (allow_incomplete) un cobro
          // rechazado NO lanza error: Stripe cambia el precio igualmente, falla
          // el cargo, deja la suscripción en past_due y responde 200; el plan
          // acababa marcado en Firestore sin haberse pagado (issue #66).
          //
          // Se usa pending_if_incomplete y NO error_if_incomplete porque este
          // último no soporta pagos que requieren autenticación: ante un 3DS/SCA
          // devuelve error en lugar de crear el PaymentIntent, así que esas
          // tarjetas jamás podrían completar el upgrade. Con pending_if_incomplete
          // el cambio queda PENDIENTE y solo se aplica cuando el pago se
          // confirma, que es exactamente la garantía que se busca.
          payment_behavior: 'pending_if_incomplete',
          expand: ['latest_invoice'],
        },
        { idempotencyKey },
      );
    } catch (error) {
      const reconciled = await this.reconcileIndeterminateUpgrade(
        error,
        userId,
        targetPlan,
        user.stripeSubscriptionId,
        newPriceId,
        upgradeContext,
        lockToken,
        idempotencyKey,
      );
      if (reconciled) {
        // La reconciliación es un desenlace definitivo: se sabe que el cambio
        // se aplicó, así que el próximo intento debe partir de clave nueva.
        await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);
        return reconciled;
      }
      // Una lectura inmediata que todavía muestre el plan anterior NO convierte
      // un error indeterminado en un fallo definitivo: la mutación puede seguir
      // ejecutándose en Stripe o ser reconciliada después. La clave se conserva
      // y la respuesta no afirma que el plan haya quedado igual.
      const type = (error as { type?: string }).type;
      if (type === 'StripeConnectionError' || type === 'StripeAPIError') {
        // Se registra aquí porque este `throw` no pasa por throwStripeApiError,
        // que es quien normalmente deja el rastro. Sin esto, el desenlace con un
        // cobro posiblemente en vuelo sería el peor instrumentado de todo el
        // flujo: solo quedaría el warn de la reconciliación, sin el mensaje
        // original de Stripe y un nivel por debajo del que disparan las alertas.
        this.logger.error(
          `CRITICAL: subscriptions.update quedó indeterminado (${type}) y la reconciliación ` +
            `no pudo confirmar el desenlace — ${upgradeContext}. La clave de idempotencia se ` +
            `conserva para el reintento. Detalle: ${(error as { message?: string }).message}`,
        );
        throw new ServiceUnavailableException(
          'We could not confirm whether your plan change went through. Please check your billing ' +
            'settings before trying again, or contact support@zplpdf.com.',
        );
      }

      // Los desenlaces no indeterminados sí liberan la clave: un intento nuevo
      // no debe recibir de Stripe el error cacheado del anterior.
      await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);
      this.throwStripeApiError(
        error,
        'subscriptions.update',
        upgradeContext,
        ' Your plan has not been changed.',
      );
    }

    // Instante en que Stripe confirmó el estado que se va a escribir. Se toma
    // tras la respuesta, no antes de la llamada: el dato solo es válido desde
    // que Stripe lo devolvió.
    const confirmedAt = new Date();

    // pending_update presente = el cobro no se completó (tarjeta rechazada o
    // 3DS sin confirmar) y el cambio NO se ha aplicado. El plan no se toca; se
    // le da al cliente el enlace de Stripe donde puede pagar o autenticar, y al
    // confirmarse el pago Stripe aplica el cambio y lo sincroniza por webhook.
    if (updatedSubscription.pending_update) {
      // Definitivo: hay una factura esperando. Si el cliente vuelve a intentarlo
      // más adelante, debe ser un intento nuevo y no la respuesta cacheada.
      await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);
      this.throwPendingPaymentError(updatedSubscription, upgradeContext);
    }

    // Defensa en profundidad: el plan solo se marca cuando la suscripción queda
    // confirmada en un estado que da derecho a él.
    //
    // Se compara contra la misma lista que autorizó el cambio, no contra `active`
    // a secas. Exigir `active` aquí después de haber admitido `trialing` arriba
    // aplicaría el precio nuevo en Stripe y luego devolvería error sin escribir
    // el plan: contrato y entitlements desincronizados, y el cliente leyendo que
    // no se cambió nada mientras se le facturará el plan superior al acabar la
    // prueba. La salida no es prohibir `trialing` en el upgrade —eso reabriría el
    // callejón de #65 con otro estado, porque el checkout lo tiene por vivo y
    // remite aquí—, sino aceptar el estado en que Stripe deja el contrato.
    if (
      !PaymentsService.ESTADOS_MODIFICABLES.includes(updatedSubscription.status)
    ) {
      this.logger.error(
        `Upgrade no confirmado: la suscripción quedó en '${updatedSubscription.status}' ` +
          `tras el cambio de precio — ${upgradeContext}. No se actualiza el plan en Firestore.`,
      );
      await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);
      throw new BadRequestException(
        `We could not confirm the payment for your plan change (subscription status: ` +
          `${updatedSubscription.status}). Your plan has not been changed. ` +
          `Please check your payment method and try again.`,
      );
    }

    // Update user plan in Firestore.
    //
    // Sellado con el instante de la confirmación de Stripe, no con `updateUser`
    // a secas: el webhook `customer.subscription.updated` escribe por el mismo
    // camino, y sin un reloj común una lectura suya anterior a este cambio
    // podría aterrizar después y revertir el plan recién pagado (issue #74).
    // Cualquier lectura previa a esta respuesta es, por definición, más vieja.
    // El rechazo se trata igual que el `false`: llegados aquí Stripe ya cobró y
    // confirmó, así que una caída de Firestore no puede convertirse en un 500
    // genérico —el cliente leería "error" sobre un cargo que sí ocurrió—.
    let persisted = false;
    let falloAlEscribir = false;
    try {
      persisted = await this.firestoreService.updateUserSubscriptionState(
        userId,
        { plan: targetPlan },
        confirmedAt,
        lockToken,
      );
    } catch (persistError) {
      falloAlEscribir = true;
      this.logger.error(
        `No se pudo escribir el plan tras el cobro — ${upgradeContext}. ` +
          `Detalle: ${(persistError as Error).message}`,
      );
    }

    // La clave se libera aparte y comparando: borrarla en la misma escritura
    // sería incondicional y podría pisar la de un intento posterior. Va antes de
    // comprobar el resultado porque el cobro ya pasó pase lo que pase: un
    // reintento no debe repetir la mutación, y la revalidación de arriba lo
    // abortaría de todas formas.
    await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);

    if (!persisted) {
      this.throwUnsyncedUpgradeError(
        targetPlan,
        upgradeContext,
        falloAlEscribir ? 'fallo al escribir en Firestore' : 'relevo del lease',
      );
    }

    this.logger.log(
      `User ${userId} upgraded from ${user.plan.toUpperCase()} to ${targetPlan.toUpperCase()}`,
    );

    return {
      success: true,
      message: `Successfully upgraded to ${targetPlan.toUpperCase()}. Proration has been applied.`,
    };
  }

  /**
   * Estados en los que una suscripción sigue dando derecho al plan.
   *
   * Es la ÚNICA fuente de verdad: `createCheckoutSession`, `upgradeSubscription`
   * y la adopción del checkout la consultan en lugar de mantener su propia lista.
   * Que hubiera dos fue justo lo que encerró al cliente de #65: checkout tenía a
   * `past_due` por viva y remitía al upgrade, y el upgrade la rechazaba por no
   * estar `active`. No quedaba ningún camino.
   *
   * `past_due` NO está, y esa es la política de cobro decidida en #65: el primer
   * cobro fallido de una renovación cancela la suscripción y devuelve al cliente
   * a Free (`handlePaymentFailed`). Deja de ser una espera con plan concedido y
   * pasa a ser un tránsito de segundos hacia la cancelación.
   */
  private static readonly ESTADOS_VIVOS = ['active', 'trialing'];

  /**
   * Estados desde los que se puede modificar el plan de una suscripción viva.
   *
   * Coincide hoy con `ESTADOS_VIVOS` y se declara aparte porque responde a otra
   * pregunta: aquella dice si el cliente tiene derecho al plan, esta si Stripe
   * admite un `subscriptions.update` con proración sobre ese contrato. `trialing`
   * entra porque Stripe permite el cambio de precio durante la prueba y no cobra
   * hasta que termina —hoy es teórico, el proyecto no configura `trial_period_days`.
   */
  private static readonly ESTADOS_MODIFICABLES = ['active', 'trialing'];

  /**
   * Estados de cobro fallido: la suscripción existe en Stripe pero ya no da
   * derecho al plan. Con la política de #65 no deberían durar más que el viaje
   * del webhook, pero se comprueban igual porque un webhook puede perderse y
   * porque `unpaid` es el destino de las cuentas cuyo dunning quedó configurado
   * de otra forma en el Dashboard.
   */
  private static readonly ESTADOS_IMPAGADOS = ['past_due', 'unpaid'];

  /**
   * Decide si el alta del checkout debe fijar el plan del usuario.
   *
   * `checkout.session.completed` acredita un alta que OCURRIÓ, no que sea el
   * contrato vigente: Stripe lo reentrega ante fallos y no garantiza el orden,
   * así que puede llegar días tarde y describir una suscripción ya cancelada, o
   * una duplicada inferior a la que el cliente tiene viva. Adoptarlo a ciegas
   * degradaría un plan superior y en curso.
   *
   * El pago se contabiliza igual: lo que se separa aquí es el entitlement.
   */
  private async puedeAdoptarseElCheckout(
    userId: string,
    vigente: User | null,
    delCheckout: Stripe.Subscription | null,
    planDelCheckout: PaidPlanType,
  ): Promise<boolean> {
    if (!delCheckout) {
      return false;
    }

    if (!PaymentsService.ESTADOS_VIVOS.includes(delCheckout.status)) {
      this.logger.warn(
        `Checkout de ${userId} no adoptado: la suscripción ${delCheckout.id} ya ` +
          `está en '${delCheckout.status}'. Se registra el pago, no el plan.`,
      );
      return false;
    }

    // Sin contrato previo, o el mismo: adopción directa.
    if (
      !vigente?.stripeSubscriptionId ||
      vigente.stripeSubscriptionId === delCheckout.id
    ) {
      return true;
    }

    let actual: Stripe.Subscription;
    try {
      actual = await this.stripe.subscriptions.retrieve(
        vigente.stripeSubscriptionId,
      );
    } catch (error) {
      // "No puedo decidir" NO es "decido que no": devolver `false` aquí daría
      // 200, Stripe daría el evento por entregado y un cliente cuyo contrato SÍ
      // debía adoptarse se quedaría sin el plan que pagó, para siempre. Se
      // propaga para que Stripe reentregue; la contabilidad va después de este
      // punto, así que tampoco se registra dos veces.
      this.logger.error(
        `No se pudo leer la suscripción vigente ${vigente.stripeSubscriptionId} ` +
          `de ${userId} para decidir el alta de ${delCheckout.id}. Se pide ` +
          `reentrega. Detalle: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Could not compare subscriptions to resolve the checkout',
      );
    }

    if (!PaymentsService.ESTADOS_VIVOS.includes(actual.status)) {
      this.logger.log(
        `Checkout de ${userId} adoptado: la anterior ${actual.id} está en ` +
          `'${actual.status}'.`,
      );
      return true;
    }

    // Dos contratos vivos a la vez: el cliente está pagando dos veces y hace
    // falta intervención humana. Mientras tanto se le deja el plan más alto —no
    // se le quita algo que está pagando— y a igualdad gana el más reciente, que
    // es el que acaba de contratar.
    const planActual = actual.items.data[0]?.price?.id
      ? this.getPlanFromPriceId(actual.items.data[0].price.id)
      : null;

    if (!planActual) {
      // Mismo caso: no se sabe con qué se está comparando. Se pide reentrega en
      // vez de decidir a ciegas — si el price ID que falta se configura dentro
      // de la ventana de reintentos, el alta se aplica sola.
      this.logger.error(
        `CRITICAL: no se pudo resolver el plan de la suscripción vigente ` +
          `${actual.id} de ${userId}. Se pide reentrega del checkout ` +
          `${delCheckout.id}. Revisar STRIPE_*_PRICE_ID.`,
      );
      throw new ServiceUnavailableException(
        'Could not resolve the current plan to compare subscriptions',
      );
    }

    const adopta =
      PLAN_ORDER[planDelCheckout] > PLAN_ORDER[planActual] ||
      (PLAN_ORDER[planDelCheckout] === PLAN_ORDER[planActual] &&
        (delCheckout.created ?? 0) > (actual.created ?? 0));

    this.logger.error(
      `CRITICAL: ${userId} tiene DOS suscripciones vivas — ${actual.id} ` +
        `(${planActual}, ${actual.status}) y ${delCheckout.id} ` +
        `(${planDelCheckout}, ${delCheckout.status}). Se ${adopta ? 'adopta' : 'mantiene'} ` +
        `el contrato ${adopta ? 'del checkout' : 'anterior'}. Revisar y cancelar la duplicada.`,
    );

    return adopta;
  }

  async handleCheckoutCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const userId = session.metadata?.firebaseUid;

    // Detailed logging for debugging
    this.logger.log(
      `Processing checkout.session.completed: session=${session.id}, ` +
        `userId=${userId || 'MISSING'}, subscription=${session.subscription}, ` +
        `customer=${session.customer}`,
    );

    if (!userId) {
      this.logger.error(
        `No firebaseUid in session metadata. Session: ${session.id}, ` +
          `Customer: ${session.customer}, Email: ${session.customer_details?.email}`,
      );
      return;
    }

    const subscriptionId = session.subscription as string;
    const user = await this.firestoreService.getUserById(userId);

    const billingCountry =
      session.customer_details?.address?.country || undefined;
    const billingCity = session.customer_details?.address?.city || undefined;
    const currency = (session.currency?.toLowerCase() || 'usd') as
      | 'usd'
      | 'mxn';
    const amount = session.amount_total || 0;

    // El alta cierra el mismo ciclo observar→escribir que el upgrade y el
    // webhook de `updated`: relee la suscripción en Stripe y escribe el plan.
    // Fuera del mutex, un checkout retrasado podía leer PRO, dejar que el
    // upgrade escribiera PROMAX y luego restaurar PRO (issue #77).
    const alta = await this.withSubscriptionSyncLock(
      userId,
      async (lockToken) => {
        // El usuario se relee dentro del lease: el leído fuera pudo esperar aquí
        // mientras otro ciclo cambiaba el contrato, y el aviso de duplicado —y
        // la decisión de adoptar esta suscripción— deben partir de datos
        // vigentes, no de los de hace unos minutos.
        const vigente =
          (await this.firestoreService.getUserById(userId)) ?? user;

        let resuelto: PaidPlanType | null = null;
        let periodStart: Date | undefined;
        let periodEnd: Date | undefined;
        let delCheckout: Stripe.Subscription | null = null;
        // Si la relectura falla no se escribe nada, así que este valor solo se
        // usa cuando hay estado observado detrás.
        let readAt = new Date();

        try {
          delCheckout =
            await this.stripe.subscriptions.retrieve(subscriptionId);
          readAt = new Date();
          const priceId = delCheckout.items.data[0]?.price?.id;
          if (priceId) {
            resuelto = this.getPlanFromPriceId(priceId);
          }
          const period = this.resolveBillingPeriod(delCheckout);
          periodStart = period.start;
          periodEnd = period.end;
        } catch (error) {
          this.logger.warn(
            `Failed to get subscription details: ${error.message}`,
          );
        }

        // Si no se pudo resolver el plan desde el price ID, NO asignar uno por
        // defecto: hacerlo regalaría un plan (potencialmente superior) por mala
        // configuración. Abortamos y registramos error crítico; Stripe
        // reintentará el webhook.
        if (!resuelto) {
          this.logger.error(
            `CRITICAL: No se pudo determinar el plan para checkout de user ${userId} ` +
              `(session ${session.id}, sub ${subscriptionId}). Plan NO asignado. Revisar STRIPE_*_PRICE_ID.`,
          );
          throw new Error(
            `Cannot resolve plan for checkout session ${session.id}`,
          );
        }

        // El evento acredita un alta HISTÓRICA, no que sea el contrato vigente:
        // Stripe puede reentregarlo días después y fuera de orden, y para
        // entonces esa suscripción puede estar cancelada o ser una duplicada
        // inferior a la que el cliente tiene viva. La contabilidad del pago va
        // aparte y se registra igual; lo que se decide aquí es el entitlement.
        const adoptable = await this.puedeAdoptarseElCheckout(
          userId,
          vigente,
          delCheckout,
          resuelto,
        );

        if (!adoptable) {
          return { plan: resuelto, adoptado: false };
        }

        // IMPORTANT: Only include period fields if they have values - Firestore rejects undefined
        const subscriptionData: Record<string, unknown> = {
          plan: resuelto,
          stripeSubscriptionId: subscriptionId,
        };
        if (periodStart) {
          subscriptionData.subscriptionPeriodStart = periodStart;
        }
        if (periodEnd) {
          subscriptionData.subscriptionPeriodEnd = periodEnd;
        }

        const applied = await this.withRetry(
          () =>
            this.firestoreService.updateUserSubscriptionState(
              userId,
              subscriptionData,
              readAt,
              lockToken,
            ),
          `handleCheckoutCompleted(${userId})`,
        );

        if (!applied) {
          // El documento ya refleja algo más fresco. No es un fallo: el alta se
          // dio por buena en Stripe y el estado vigente es el que hay.
          this.logger.warn(
            `Alta de ${userId} no escrita: el documento ya refleja una lectura ` +
              `posterior o el lease cambió de manos.`,
          );
        }

        return { plan: resuelto, adoptado: true };
      },
      'el alta de la suscripción',
    );
    const plan = alta.plan;

    // Calculate MXN amount for transactions
    let amountMxn = amount / 100;
    let exchangeRate = 1;
    if (currency === 'usd') {
      try {
        const conversion = await this.exchangeRateService.convertUsdToMxn(
          amount / 100,
          this.firestoreService,
        );
        amountMxn = conversion.amountMxn;
        exchangeRate = conversion.rate;
      } catch (error) {
        this.logger.warn(`Failed to get exchange rate: ${error.message}`);
        exchangeRate = 20; // Fallback
        amountMxn = (amount / 100) * exchangeRate;
      }
    }

    // La geo va aparte del estado de suscripción y fuera del mutex: no compite
    // por el plan, así que no debe descartarse junto con él si llega un sello
    // más fresco.
    if (billingCountry && (!user?.country || user.countrySource === 'ip')) {
      await this.withRetry(
        () =>
          this.firestoreService.updateUser(userId, {
            country: billingCountry,
            city: billingCity,
            countrySource: 'stripe',
            countryDetectedAt: new Date(),
          } as Partial<User>),
        `handleCheckoutCompleted(geo ${userId})`,
      );
      this.logger.log(
        `Updated user ${userId} geo to ${billingCountry}/${billingCity || 'unknown'} from Stripe billing`,
      );
    }

    this.logger.log(
      alta.adoptado
        ? `User ${userId} upgraded to ${plan} plan`
        : `Checkout de ${userId} contabilizado como ${plan} SIN fijar el plan: ` +
            `el contrato del evento no es el vigente.`,
    );

    // Segunda pasada, para las facturas siguientes. La primera ya se propagó
    // antes de abrir el checkout —Stripe congela los datos fiscales al finalizar
    // la factura—, pero aquí puede haberse detectado el país desde la dirección
    // de facturación, y con él cambia el tipo de perfil que corresponde.
    await this.billingService.syncTaxProfileToStripe(userId);

    // Determine transaction type based on previous plan
    const previousPlan = user?.plan || 'free';
    const transactionType =
      previousPlan === 'free' ? 'subscription' : 'upgrade';

    // Save transaction record
    const transactionId = this.generateTransactionId();
    const transaction: StripeTransaction = {
      id: transactionId,
      stripeEventId: session.id,
      stripeEventType: 'checkout.session.completed',
      userId,
      userEmail: user?.email || session.customer_details?.email || '',
      amount,
      currency,
      amountMxn,
      exchangeRate,
      type: transactionType,
      plan,
      stripeCustomerId: session.customer as string,
      stripeSubscriptionId: subscriptionId,
      status: 'succeeded',
      billingCountry,
      createdAt: new Date(),
    };

    await this.firestoreService.saveTransaction(transaction);
    this.logger.log(`Saved transaction: ${transactionId}`);

    // Save subscription event
    const subscriptionEvent: SubscriptionEvent = {
      id: this.generateSubscriptionEventId(),
      userId,
      userEmail: user?.email || session.customer_details?.email || '',
      eventType: 'started',
      plan,
      previousPlan: user?.plan || 'free',
      currency,
      mrr: amount / 100,
      mrrMxn: amountMxn,
      stripeSubscriptionId: subscriptionId,
      country: billingCountry,
      createdAt: new Date(),
    };

    await this.firestoreService.saveSubscriptionEvent(subscriptionEvent);
    this.logger.log(`Saved subscription event: started for user ${userId}`);

    // Track purchase in GA4 (server-side)
    const planNames: Record<PaidPlanType, string> = {
      lite: 'Plan Lite',
      pro: 'Plan Pro',
      promax: 'Plan Pro Max',
      enterprise: 'Plan Enterprise',
    };
    await this.ga4Service.trackPurchase({
      userId,
      transactionId: session.id,
      planId: `plan_${plan}`,
      planName: planNames[plan],
      price: session.amount_total ? session.amount_total / 100 : 0,
      currency: session.currency?.toUpperCase() || 'USD',
    });
  }

  private generateTransactionId(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `transaction_${dateStr}_${random}`;
  }

  private generateSubscriptionEventId(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `sub_event_${dateStr}_${random}`;
  }

  /**
   * Devuelve el estado VIGENTE de la suscripción en Stripe, junto al instante en
   * que se observó.
   *
   * El sello se toma DESPUÉS de la respuesta, nunca antes de la llamada: lo que
   * ordena las escrituras es cuándo se observó el estado, no cuándo se pidió. Si
   * se sellara al inicio, una petición lenta que acaba viendo el estado nuevo
   * llevaría un sello menor que otra posterior que vio el viejo, y la guarda
   * descartaría precisamente la lectura buena.
   *
   * Ningún fallo cae al snapshot del evento. `resource_missing` tampoco: Stripe
   * lo devuelve ante un ID inválido o inexistente —entorno cruzado, clave sin
   * acceso—, no como prueba de que la suscripción terminara; las canceladas
   * siguen siendo recuperables. Tratarlo como lectura fresca sellaría un
   * snapshot viejo como vigente y podría restaurar un plan de pago. Sin estado
   * verificado no se escribe: el error se propaga y Stripe reintenta el webhook.
   */
  private async fetchCurrentSubscription(
    subscription: Stripe.Subscription,
  ): Promise<{ current: Stripe.Subscription; readAt: Date }> {
    try {
      const current = await this.stripe.subscriptions.retrieve(subscription.id);
      return { current, readAt: new Date() };
    } catch (error) {
      if ((error as { code?: string }).code === 'resource_missing') {
        this.logger.error(
          `CRITICAL: Stripe no reconoce la suscripción ${subscription.id} del evento ` +
            `subscription.updated. No se escribe nada. Revisar si la clave apunta al ` +
            `entorno correcto o si le faltan permisos de lectura.`,
        );
      }
      throw error;
    }
  }

  /**
   * Serializa el ciclo relectura→escritura de un usuario y lo ejecuta.
   *
   * Sin esto, dos ciclos solapados pueden aterrizar en orden inverso al de los
   * estados que observaron: el sello mide cuándo llegó la respuesta a Cloud Run,
   * no cuándo Stripe observó el estado, y entre ambos instantes cabe una red
   * lenta (issue #77). Con los ciclos serializados, la última lectura es siempre
   * la más reciente.
   *
   * Si otro ciclo lo tiene tomado se lanza, y Stripe reentrega el webhook con su
   * backoff. Esperar aquí sería peor: bloquearía el manejador hasta agotar el
   * plazo de respuesta del webhook, y Stripe lo reintentaría igualmente.
   */
  private async withSubscriptionSyncLock<T>(
    userId: string,
    operation: (lockToken: string) => Promise<T>,
    contexto = 'webhook',
  ): Promise<T> {
    const token = await this.firestoreService.acquireSubscriptionSyncLock(
      userId,
      PaymentsService.SUBSCRIPTION_SYNC_LEASE_MS,
    );

    if (!token) {
      this.logger.warn(
        `Sincronización de suscripción de ${userId} ya en curso; se rechaza ` +
          `${contexto}.`,
      );
      throw new ConflictException(
        'Another change to this subscription is already in progress. Please try again in a moment.',
      );
    }

    try {
      // El token viaja hasta la escritura: si este ciclo se demora más que el
      // lease y otro lo releva, la transacción de escritura lo descarta.
      return await operation(token);
    } finally {
      // En `finally` a propósito: un ciclo que lanza a mitad —relectura fallida,
      // Firestore caído— no debe dejar el lease tomado hasta que caduque.
      try {
        await this.firestoreService.releaseSubscriptionSyncLock(userId, token);
      } catch (error) {
        // El lease caduca solo; no vale la pena convertir esto en un fallo del
        // webhook y provocar una reentrega de algo que ya se aplicó.
        this.logger.warn(
          `No se pudo liberar el lock de sincronización de ${userId}: ` +
            `${(error as Error).message}`,
        );
      }
    }
  }

  async handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const customerId = subscription.customer as string;
    const user =
      await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId}`);
      return;
    }

    // El lock abarca la relectura Y la escritura: separarlos volvería a permitir
    // que dos ciclos observen estados distintos y aterricen en orden inverso.
    await this.withSubscriptionSyncLock(user.id, (lockToken) =>
      this.syncSubscriptionState(user, subscription, lockToken),
    );
  }

  private async syncSubscriptionState(
    userPrevio: User,
    subscription: Stripe.Subscription,
    lockToken: string,
  ): Promise<void> {
    // El mutex ordena las ejecuciones, pero no demuestra que el evento siga
    // siendo del contrato vigente: uno retrasado de una suscripción anterior
    // puede adquirir el lease cuando ya es otra la buena. El usuario se relee
    // DENTRO del lease, porque el leído fuera pudo quedarse viejo esperándolo.
    const user =
      (await this.firestoreService.getUserById(userPrevio.id)) ?? userPrevio;

    // Sin `stripeSubscriptionId` es un alta cuyo checkout aún no ha aterrizado:
    // ahí no hay con qué comparar y descartar perdería la sincronización.
    if (
      user.stripeSubscriptionId &&
      user.stripeSubscriptionId !== subscription.id
    ) {
      this.logger.warn(
        `Ignorado subscription.updated de ${subscription.id}: el usuario ` +
          `${user.id} tiene activa ${user.stripeSubscriptionId}.`,
      );
      return;
    }

    // El snapshot del evento NO es fuente de verdad. Stripe no garantiza el
    // orden de entrega, y el upgrade con `pending_if_incomplete` emite dos
    // eventos: uno con el precio ANTERIOR cuando el cambio queda pendiente de
    // cobro, y otro con el nuevo cuando el pago se confirma. Si el primero se
    // entrega tarde —reintento, latencia, 3DS de por medio— aplicarlo
    // degradaría un plan ya pagado (issue #74). Se relee el estado vigente y se
    // escribe ese, sellado con el instante en que se observó para que una
    // escritura más fresca no pueda ser pisada por otra que observó antes.
    const { current, readAt } =
      await this.fetchCurrentSubscription(subscription);

    if (current.status !== subscription.status) {
      this.logger.warn(
        `El snapshot de subscription.updated para ${subscription.id} llegó como ` +
          `'${subscription.status}' pero Stripe la tiene en '${current.status}'. ` +
          `Se aplica el estado vigente.`,
      );
    }

    // Get plan from subscription price
    const priceId = current.items.data[0]?.price?.id;
    const plan = priceId ? this.getPlanFromPriceId(priceId) : null;

    // Si la suscripción está activa pero no podemos resolver el plan, no tocamos
    // el plan del usuario (evita asignar uno incorrecto por mala configuración).
    if (current.status === 'active' && !plan) {
      this.logger.error(
        `CRITICAL: No se pudo determinar el plan para subscription.updated de user ${user.id} ` +
          `(sub ${current.id}). Plan NO actualizado. Revisar STRIPE_*_PRICE_ID.`,
      );
      return;
    }

    // Check subscription status with retry
    const period = this.resolveBillingPeriod(current);

    if (current.status === 'active') {
      // IMPORTANT: Only include period fields if they have values - Firestore rejects undefined
      const activeUpdateData: Record<string, unknown> = {
        plan,
        stripeSubscriptionId: current.id,
      };
      if (period.start) {
        activeUpdateData.subscriptionPeriodStart = period.start;
      }
      if (period.end) {
        activeUpdateData.subscriptionPeriodEnd = period.end;
      }
      const applied = await this.withRetry(
        () =>
          this.firestoreService.updateUserSubscriptionState(
            user.id,
            activeUpdateData,
            readAt,
            lockToken,
          ),
        `handleSubscriptionUpdated(${user.id})`,
      );
      this.logger.log(
        applied
          ? `Subscription updated for user ${user.id}: active (${plan})`
          : `Subscription updated descartado para user ${user.id}: el documento ya refleja una lectura posterior`,
      );
    } else if (['canceled', 'unpaid', 'past_due'].includes(current.status)) {
      // `past_due` entra aquí desde #65: antes tenía una rama propia que
      // conservaba el plan "para dar tiempo a pagar", y eso concedía plan sin
      // cobro.
      //
      // Pero degradar no basta, y suponer que sí fue un error: limpiar el
      // `stripeSubscriptionId` sin cancelar en Stripe deja el contrato vivo y sin
      // dueño. Si este evento se adelanta a `invoice.payment_failed` —Stripe no
      // garantiza el orden—, el usuario se queda sin ID, contrata de nuevo (la
      // defensa por customer solo lista `active`, así que no ve la impagada), y
      // el `payment_failed` que llega después descarta el evento por apuntar a
      // otro contrato. El viejo sobrevive, y con la tarjeta ya al día Stripe
      // puede cobrarlo: dos suscripciones cobrables sobre el mismo cliente.
      //
      // Liquidando aquí también, los dos caminos convergen y el orden deja de
      // importar de verdad. La liquidación es reanudable e idempotente, así que
      // que ambos la ejecuten no duplica nada.
      if (PaymentsService.ESTADOS_IMPAGADOS.includes(current.status)) {
        const invoiceId =
          typeof current.latest_invoice === 'string'
            ? current.latest_invoice
            : (current.latest_invoice?.id ?? null);
        const contexto = `user ${user.id} (subscription.updated en '${current.status}', sub ${current.id})`;

        // Sin factura que consultar no hay cobro que comprobar: se cancela y
        // punto. Es un caso de borde —una suscripción impagada siempre trae su
        // `latest_invoice`—, pero dejarlo sin cancelar reabriría el agujero.
        let liquidado = true;

        if (invoiceId) {
          liquidado = await this.liquidarSuscripcionImpagada(
            invoiceId,
            current.id,
            contexto,
          );
        } else {
          await this.cancelarSuscripcion(current.id, contexto);
        }

        // La factura se saldó entre que Stripe emitió el evento y ahora: el
        // contrato está al corriente y degradar castigaría a quien acaba de pagar.
        if (!liquidado) {
          this.logger.log(
            `Degradación abortada: la factura se cobró — ${contexto}.`,
          );
          return;
        }
      }

      // Por el punto único: si el cobro fallido ya aplicó esta misma baja, aquí
      // no se reescribe, no se manda un segundo correo y no se cuenta otra vez.
      // Y si este camino llega primero, es este el que la contabiliza — antes no
      // lo hacía ninguno de los dos y la baja podía no aparecer en el panel.
      await this.registrarBajaDefinitiva(
        user,
        current.id,
        PaymentsService.ESTADOS_IMPAGADOS.includes(current.status)
          ? 'payment_failed'
          : 'canceled',
        readAt,
        lockToken,
      );
    }
  }

  async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const customerId = subscription.customer as string;
    const user =
      await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId}`);
      return;
    }

    // FIX: Only process if the deleted subscription matches the user's current subscription
    // This prevents orphan/duplicate subscription deletions from affecting the user's active plan
    //
    // Esta comprobación previa solo evita trabajo: la que decide es la de dentro
    // del lease, porque entre esta lectura y el lock puede cambiar el contrato.
    if (
      user.stripeSubscriptionId &&
      user.stripeSubscriptionId !== subscription.id
    ) {
      this.logger.warn(
        `Ignoring subscription.deleted for ${subscription.id} - ` +
          `user ${user.id} has different active subscription: ${user.stripeSubscriptionId}`,
      );

      // Save event for tracking but DO NOT modify the user's plan
      const orphanEvent: SubscriptionEvent = {
        id: this.generateSubscriptionEventId(),
        userId: user.id,
        userEmail: user.email,
        eventType: 'canceled_orphan',
        plan: 'pro', // Unknown, but log something
        previousPlan: user.plan || 'free',
        currency: 'usd',
        mrr: 0,
        mrrMxn: 0,
        stripeSubscriptionId: subscription.id,
        cancellationReason:
          subscription.cancellation_details?.reason || 'orphan_subscription',
        country: user.country,
        createdAt: new Date(),
      };

      await this.firestoreService.saveSubscriptionEvent(orphanEvent);
      this.logger.log(
        `Saved orphan subscription event for ${subscription.id} (user has ${user.stripeSubscriptionId})`,
      );
      return;
    }

    // La baja también escribe el plan, así que entra en el mutex y por la
    // escritura sellada: con `updateUser` a secas podía pisar un upgrade recién
    // confirmado sin que nada lo comparase (issue #77). No relee Stripe —el
    // evento ya es terminal—, y dentro del mutex no hay otro ciclo con el que
    // competir, así que el sello se toma justo antes de escribir.
    const resultado = await this.withSubscriptionSyncLock(
      user.id,
      async (lockToken) => {
        // Revalidación dentro del lease: un `deleted` retrasado de un contrato
        // anterior podría adquirirlo cuando ya hay otro vigente y dejar al
        // cliente en Free habiendo pagado.
        const fresh =
          (await this.firestoreService.getUserById(user.id)) ?? user;

        if (
          fresh.stripeSubscriptionId &&
          fresh.stripeSubscriptionId !== subscription.id
        ) {
          this.logger.warn(
            `Ignorado subscription.deleted de ${subscription.id} dentro del ` +
              `lease: el usuario ${user.id} ya tiene activa ` +
              `${fresh.stripeSubscriptionId}.`,
          );
          return { aplicado: false as const };
        }

        // Eco de una baja ya aplicada. Desde #65 lo provoca el flujo normal: la
        // cancelación por impago la lanza este mismo servicio, y Stripe devuelve
        // el `deleted` cuando el usuario ya está en Free y sin contrato. Sin este
        // corte se reescribe lo mismo, se manda un segundo correo de degradación
        // —a veces un tercero, contando el de `subscription.updated`— y se guarda
        // otro evento de baja, con lo que el churn queda contado por duplicado.
        // Peor aún: con el plan ya en `free`, el cálculo de abajo cae al
        // `'pro'` por defecto, así que a un cliente de LITE se le nombraría un
        // plan que nunca tuvo.
        if (fresh.plan === 'free' && !fresh.stripeSubscriptionId) {
          this.logger.log(
            `subscription.deleted de ${subscription.id} es eco de una baja ya ` +
              `aplicada para ${user.id}; no se reescribe ni se vuelve a avisar.`,
          );
          return { aplicado: false as const };
        }

        // El plan cancelado sale de la lectura de DENTRO del lease: si un
        // `subscription.updated` pendiente escribió PROMAX entre la lectura
        // inicial y esta, la baja se aplicaría bien pero se registraría y se
        // notificaría como PRO.
        const canceladoAhora =
          fresh.plan === 'lite' ||
          fresh.plan === 'pro' ||
          fresh.plan === 'promax'
            ? fresh.plan
            : 'pro';

        const escrito = await this.withRetry(
          () =>
            this.firestoreService.updateUserSubscriptionState(
              user.id,
              {
                plan: 'free',
                stripeSubscriptionId: null,
              },
              new Date(),
              lockToken,
            ),
          `handleSubscriptionDeleted(${user.id})`,
        );

        return { aplicado: escrito, canceledPlan: canceladoAhora };
      },
      'la baja de la suscripción',
    );

    const canceledPlan = resultado.canceledPlan ?? 'pro';

    if (!resultado.aplicado) {
      this.logger.warn(
        `Baja de ${user.id} no escrita: el documento ya refleja una lectura ` +
          `posterior o el lease cambió de manos.`,
      );
      return;
    }

    this.logger.log(
      `User ${user.id} downgraded to Free plan (was ${canceledPlan})`,
    );

    // Send downgrade notification email
    this.emailService
      .queueSubscriptionDowngradedEmail(
        {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          language: this.detectLanguageFromCountry(user.country),
        },
        canceledPlan,
        'canceled',
      )
      .catch((err) =>
        this.logger.error(
          `Failed to queue subscription downgraded email: ${err.message}`,
        ),
      );

    // Save subscription event for churn tracking
    const subscriptionEvent: SubscriptionEvent = {
      id: this.generateSubscriptionEventId(),
      userId: user.id,
      userEmail: user.email,
      eventType: 'canceled',
      plan: canceledPlan,
      previousPlan: canceledPlan,
      currency: 'usd', // Default, actual currency not available in deleted event
      mrr: 0,
      mrrMxn: 0,
      stripeSubscriptionId: subscription.id,
      cancellationReason:
        subscription.cancellation_details?.reason || undefined,
      country: user.country,
      createdAt: new Date(),
    };

    await this.firestoreService.saveSubscriptionEvent(subscriptionEvent);
    this.logger.log(`Saved subscription event: canceled for user ${user.id}`);
  }

  /**
   * Aplica una baja definitiva: degrada a Free, avisa al cliente y la contabiliza.
   *
   * Existe porque tres caminos distintos observan la MISMA baja —el cobro
   * fallido, el `subscription.updated` que lo refleja y el `subscription.deleted`
   * que provoca nuestra propia cancelación— y cada uno traía su mezcla de
   * escritura, aviso y registro. De ahí salían los dos defectos que el review
   * destapó: el cliente recibía un correo por cada camino, y la baja podía no
   * contabilizarse en ninguno.
   *
   * Los tres pasos van juntos y una sola vez: **el primero que llega la aplica**
   * y los demás la ven aplicada. El corte no es una marca aparte que mantener,
   * sino el propio estado resultante —Free y sin contrato—, que ningún otro
   * camino puede confundir con una baja pendiente.
   *
   * El aviso y el registro van atados a que la escritura se aplique de verdad:
   * si el fencing la descarta por obsoleta, no hay baja que contar ni de la que
   * avisar.
   *
   * @returns `true` si esta llamada fue la que aplicó la baja.
   */
  private async registrarBajaDefinitiva(
    user: User,
    subscriptionId: string,
    motivo: 'payment_failed' | 'canceled',
    readAt: Date,
    lockToken: string,
  ): Promise<boolean> {
    if (user.plan === 'free' && !user.stripeSubscriptionId) {
      this.logger.log(
        `Baja de ${user.id} (${motivo}) ya aplicada por otro camino; no se ` +
          `reescribe, ni se avisa, ni se cuenta dos veces.`,
      );
      return false;
    }

    // El plan que se pierde sale del documento, no del evento: es el que el
    // cliente tenía reconocido y el que hay que nombrarle en el aviso.
    const planPerdido: PaidPlanType =
      user.plan === 'lite' ||
      user.plan === 'pro' ||
      user.plan === 'promax' ||
      user.plan === 'enterprise'
        ? user.plan
        : 'pro';

    const aplicado = await this.withRetry(
      () =>
        this.firestoreService.updateUserSubscriptionState(
          user.id,
          { plan: 'free', stripeSubscriptionId: null },
          readAt,
          lockToken,
        ),
      `registrarBajaDefinitiva(${user.id})`,
    );

    if (!aplicado) {
      this.logger.log(
        `Baja de ${user.id} (${motivo}) descartada: el documento ya refleja ` +
          `una lectura posterior.`,
      );
      return false;
    }

    this.logger.warn(
      `Baja aplicada para ${user.id}: ${planPerdido.toUpperCase()} → free (${motivo}).`,
    );

    this.emailService
      .queueSubscriptionDowngradedEmail(
        {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          language: this.detectLanguageFromCountry(user.country),
        },
        planPerdido,
        motivo,
      )
      .catch((err) =>
        this.logger.error(
          `Failed to queue subscription downgraded email: ${err.message}`,
        ),
      );

    // `churned` distingue la baja involuntaria de la que el cliente decide, y
    // las métricas ya lo cuentan junto a `canceled` (`finance.service.ts`), así
    // que separar no esconde ninguna baja del panel.
    await this.firestoreService.saveSubscriptionEvent({
      id: this.generateSubscriptionEventId(),
      userId: user.id,
      userEmail: user.email,
      eventType: motivo === 'payment_failed' ? 'churned' : 'canceled',
      plan: planPerdido,
      previousPlan: planPerdido,
      currency: user.country === 'MX' ? 'mxn' : 'usd',
      mrr: 0,
      mrrMxn: 0,
      stripeSubscriptionId: subscriptionId,
      cancellationReason: motivo,
      country: user.country,
      createdAt: new Date(),
    });

    return true;
  }

  /**
   * Liquida en Stripe una suscripción cuyo cobro no prosperó: anula la factura
   * pendiente y cancela el contrato.
   *
   * Implementa la mitad "en Stripe" de la política de #65 —que no quede plan
   * concedido sin pagar, ni factura impagada arrastrándose—. La otra mitad, el
   * plan del usuario, la escribe quien llama, dentro del mutex de sincronización.
   *
   * **Relee la factura antes de tocar nada.** El payload del webhook describe el
   * instante del fallo, no el de ahora, y entre ambos caben minutos: reentregas
   * de Stripe, un reintento que sí cobró, o el cliente pagando a mano desde el
   * portal. Cancelar sobre ese payload le quitaría el plan a alguien que acaba de
   * pagarlo. Si la factura ya no está `open`, no hay nada que liquidar.
   *
   * **Anula antes de cancelar**, y no al revés, porque los dos fallos posibles no
   * cuestan lo mismo. Si la anulación funciona y la cancelación no, queda un
   * contrato sin deuda que el siguiente ciclo o el propio Stripe vuelven a poner
   * en evidencia. Al revés quedaría el cliente sin plan Y con una factura viva
   * persiguiéndole, que es exactamente lo que esta política venía a evitar.
   *
   * Es reanudable: si un ciclo anterior anuló la factura pero murió antes de
   * cancelar, la reentrega de Stripe encuentra la factura ya anulada y termina el
   * trabajo. Distinguir eso de una factura cobrada es justo lo que decide entre
   * rematar la liquidación y no tocar nada.
   *
   * @returns `true` si la suscripción quedó liquidada y procede degradar el plan;
   *          `false` si el cliente pagó y no hay que tocar nada.
   */
  private async liquidarSuscripcionImpagada(
    invoiceId: string,
    subscriptionId: string,
    contexto: string,
  ): Promise<boolean> {
    const factura = await this.anularFacturaPendiente(invoiceId, contexto);

    if (factura === 'cobrada') {
      return false;
    }

    await this.cancelarSuscripcion(subscriptionId, contexto);

    return true;
  }

  /**
   * Anula la factura si sigue pendiente, y dice si procede seguir liquidando.
   *
   * La distinción que devuelve NO es "estaba abierta o no", sino "hay deuda o el
   * cliente pagó", y son cosas distintas: una factura `void` significa que un
   * ciclo anterior ya hizo esta mitad del trabajo y murió antes de cancelar, así
   * que hay que REMATAR, no abortar. Conflar ambos casos dejaba contratos vivos
   * sin cobro cada vez que la cancelación fallaba y Stripe reentregaba el evento.
   *
   * `uncollectible` cuenta igual que `void`: es deuda dada por perdida, no cobro.
   * `draft` no se puede anular —no está finalizada— y tampoco acredita pago, así
   * que se deja pasar sin tocarla; la cancelación del contrato se la lleva.
   *
   * Se anula en vez de marcarse incobrable porque no hay nada devengado que
   * reclamar: el corte de servicio es inmediato, y el CFDI cuelga de
   * `invoice.payment_succeeded` (`webhooks.service.ts`), así que una factura que
   * nunca se cobró tampoco llegó a timbrarse — no hay comprobante que corregir.
   *
   * @returns `'liquidable'` si procede cancelar el contrato; `'cobrada'` si el
   *          cliente pagó y no hay que tocar nada.
   */
  private async anularFacturaPendiente(
    invoiceId: string,
    contexto: string,
  ): Promise<'liquidable' | 'cobrada'> {
    const vigente = await this.stripe.invoices.retrieve(invoiceId);

    if (vigente.status === 'paid') {
      this.logger.log(
        `Factura ${invoiceId} cobrada; no se liquida nada — ${contexto}.`,
      );
      return 'cobrada';
    }

    if (vigente.status !== 'open') {
      this.logger.log(
        `Factura ${invoiceId} en '${vigente.status}': sin cobro y sin nada que ` +
          `anular, se sigue con la cancelación — ${contexto}.`,
      );
      return 'liquidable';
    }

    await this.stripe.invoices.voidInvoice(invoiceId);
    this.logger.log(`Factura ${invoiceId} anulada — ${contexto}.`);

    return 'liquidable';
  }

  /** Cancela la suscripción salvo que Stripe ya la tenga cancelada. */
  private async cancelarSuscripcion(
    subscriptionId: string,
    contexto: string,
  ): Promise<void> {
    const suscripcion =
      await this.stripe.subscriptions.retrieve(subscriptionId);

    if (suscripcion.status === 'canceled') {
      this.logger.log(
        `La suscripción ${subscriptionId} ya estaba cancelada — ${contexto}.`,
      );
      return;
    }

    await this.stripe.subscriptions.cancel(subscriptionId);
    this.logger.log(`Suscripción ${subscriptionId} cancelada — ${contexto}.`);
  }

  /**
   * Liquida el contrato impagado que un cliente arrastra al pedir un alta nueva.
   *
   * Con `past_due` fuera de los estados vivos, el checkout ya no puede limitarse
   * a bloquear —eso era el callejón de #65—, pero tampoco puede dejar pasar sin
   * más: la suscripción anterior seguiría viva en Stripe y el cliente acabaría
   * con dos. Así que se cierra la vieja antes de abrir la nueva.
   *
   * Normalmente esto no llega a ejecutarse: `handlePaymentFailed` liquida el
   * contrato en cuanto falla el cobro. Queda para la ventana en la que el webhook
   * aún no ha llegado, se perdió, o el dunning del Dashboard dejó la suscripción
   * en `unpaid` en vez de cancelarla.
   *
   * Si la liquidación falla se bloquea el alta: crear la segunda suscripción
   * sabiendo que la primera sigue viva dejaría al cliente pagando dos veces.
   *
   * @returns `true` si el contrato quedó liquidado y el alta puede continuar;
   *          `false` si el cliente pagó entre medias y el contrato revivió.
   */
  private async liquidarContratoImpagadoAntesDelAlta(
    user: User,
    impagada: Stripe.Subscription,
  ): Promise<boolean> {
    const contexto = `user ${user.id} (alta nueva sobre contrato ${impagada.status} ${impagada.id})`;
    const invoiceId =
      typeof impagada.latest_invoice === 'string'
        ? impagada.latest_invoice
        : (impagada.latest_invoice?.id ?? null);

    let liquidado: boolean;

    try {
      liquidado = await this.withSubscriptionSyncLock(
        user.id,
        async (lockToken) => {
          // El resultado MANDA. La lectura que trajo aquí es de antes del lease,
          // y en ese hueco cabe el cliente pagando desde el portal: cancelar
          // ignorando que la factura se saldó le quitaría el contrato que acaba
          // de poner al día, y el alta que sigue le cobraría por segunda vez.
          if (invoiceId) {
            const factura = await this.anularFacturaPendiente(
              invoiceId,
              contexto,
            );

            if (factura === 'cobrada') {
              return false;
            }
          }

          await this.cancelarSuscripcion(impagada.id, contexto);

          await this.withRetry(
            () =>
              this.firestoreService.updateUserSubscriptionState(
                user.id,
                { plan: 'free', stripeSubscriptionId: null },
                new Date(),
                lockToken,
              ),
            `liquidarContratoImpagadoAntesDelAlta(${user.id})`,
          );

          return true;
        },
      );
    } catch (error) {
      this.logger.error(
        `No se pudo liquidar el contrato impagado — ${contexto}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'We could not close your previous unpaid subscription. Please try again ' +
          'in a few minutes or contact support@zplpdf.com.',
      );
    }

    this.logger.warn(
      liquidado
        ? `Contrato impagado liquidado para permitir el alta — ${contexto}.`
        : `Alta detenida: el contrato se puso al corriente mientras se liquidaba — ${contexto}.`,
    );

    return liquidado;
  }

  async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string;
    const user =
      await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(
        `No user found for customer: ${customerId} on payment failed`,
      );
      return;
    }

    // La política de "no paga → Free" (#65) se aplica SOLO a la renovación, que
    // es lo que significa literalmente no pagar la suscripción. Los otros dos
    // motivos que traen aquí un `payment_failed` no son eso:
    //
    // - `subscription_create`: el alta que no llegó a cobrarse. No hay plan que
    //   quitar —nunca se concedió— y Stripe expira sola la suscripción
    //   `incomplete` a las 23 h.
    // - `subscription_update`: la proración de un upgrade. El cliente TIENE su
    //   plan al corriente y lo que falló fue la mejora. Cancelar aquí le quitaría
    //   lo que sí pagó por no poder pagar lo que pidió de más; además el upgrade
    //   usa `pending_if_incomplete` justamente para que este fallo no toque la
    //   suscripción vigente (#73), y esto lo desharía.
    //
    // Para ambos se mantiene el comportamiento anterior: registrar y avisar.
    if (invoice.billing_reason !== 'subscription_cycle') {
      this.notificarCobroFallido(user, invoice);
      return;
    }

    const invoiceId = invoice.id;
    const subscriptionId = getSubscriptionIdFromInvoice(invoice);

    if (!invoiceId || !subscriptionId) {
      this.logger.error(
        `Cobro fallido de ${user.id} sin factura (${invoiceId ?? 'null'}) o sin ` +
          `suscripción (${subscriptionId ?? 'null'}) que liquidar. Solo se avisa.`,
      );
      this.notificarCobroFallido(user, invoice);
      return;
    }

    const contexto = `user ${user.id} (renovación impagada, sub ${subscriptionId}, factura ${invoiceId})`;

    // Mismo mutex que los webhooks de suscripción y el upgrade: esto lee el
    // estado en Stripe y escribe el plan, así que compite con ellos por el mismo
    // documento (#77). Sin el lease, la cancelación podría pisar un alta recién
    // confirmada.
    const degradado = await this.withSubscriptionSyncLock(
      user.id,
      async (lockToken) => {
        // Revalidación dentro del lease: entre el evento y este punto el cliente
        // pudo contratar de nuevo. Una factura del contrato ANTERIOR no debe
        // llevarse por delante el que ya está pagando.
        const fresh =
          (await this.firestoreService.getUserById(user.id)) ?? user;

        if (
          fresh.stripeSubscriptionId &&
          fresh.stripeSubscriptionId !== subscriptionId
        ) {
          this.logger.warn(
            `Cobro fallido ignorado: el usuario ya tiene otra suscripción ` +
              `(${fresh.stripeSubscriptionId}) — ${contexto}.`,
          );
          return false;
        }

        const liquidada = await this.liquidarSuscripcionImpagada(
          invoiceId,
          subscriptionId,
          contexto,
        );

        if (!liquidada) {
          return false;
        }

        // Degradar, avisar y contabilizar van juntos y una sola vez. El sello se
        // toma tras liquidar en Stripe: es el instante que esta escritura
        // describe, y dentro del lease no hay otro ciclo con el que competir.
        return this.registrarBajaDefinitiva(
          fresh,
          subscriptionId,
          'payment_failed',
          new Date(),
          lockToken,
        );
      },
    );

    if (!degradado) {
      this.logger.log(`Sin baja que aplicar en este ciclo — ${contexto}.`);
    }
  }

  /**
   * Aviso de cobro fallido sin degradación: los motivos que no son una
   * renovación (alta o proración de upgrade) conservan el comportamiento
   * anterior — registrar, y avisar a partir del segundo intento.
   */
  private notificarCobroFallido(user: User, invoice: Stripe.Invoice): void {
    this.logger.warn(
      `Payment failed for user ${user.id}, invoice: ${invoice.id} ` +
        `(billing_reason: ${invoice.billing_reason})`,
    );

    const attemptCount = invoice.attempt_count || 1;

    if (attemptCount < 2) {
      return;
    }

    this.logger.warn(
      `Multiple payment failures (${attemptCount}) for user ${user.id}`,
    );

    this.emailService
      .queuePaymentFailedEmail(
        {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          language: this.detectLanguageFromCountry(user.country),
        },
        attemptCount,
      )
      .catch((err) =>
        this.logger.error(
          `Failed to queue payment failed email: ${err.message}`,
        ),
      );
  }

  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const billingReason = invoice.billing_reason;

    // Skip subscription_create - already handled by checkout.session.completed
    if (billingReason === 'subscription_create') {
      this.logger.log(
        `Skipping invoice ${invoice.id}: subscription_create handled by checkout`,
      );
      return;
    }

    // Only process renewals (subscription_cycle) and updates (subscription_update)
    if (
      !['subscription_cycle', 'subscription_update'].includes(
        billingReason || '',
      )
    ) {
      this.logger.log(
        `Skipping invoice ${invoice.id}: billing_reason=${billingReason}`,
      );
      return;
    }

    const customerId = invoice.customer as string;
    const user =
      await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(
        `No user found for customer: ${customerId} on invoice paid`,
      );
      return;
    }

    // Get plan and period from invoice subscription.
    // Fallback al plan actual del usuario si no se puede resolver desde el price ID
    // (no degradamos ni regalamos plan por un price desconocido).
    let plan: PaidPlanType =
      user.plan === 'lite' || user.plan === 'pro' || user.plan === 'promax'
        ? user.plan
        : 'pro';
    let subscriptionPeriodStart: Date | undefined;
    let subscriptionPeriodEnd: Date | undefined;
    const subscriptionId = getSubscriptionIdFromInvoice(invoice);

    if (!subscriptionId) {
      // Antes se resolvía como `undefined` en todas las facturas y este bloque
      // no llegaba a ejecutarse nunca, en silencio. Si vuelve a pasar, que se
      // vea.
      this.logger.warn(
        `Invoice ${invoice.id} sin suscripción en parent.subscription_details; no se actualiza plan ni periodo`,
      );
    } else {
      try {
        const subscription =
          await this.stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0]?.price?.id;
        if (priceId) {
          const resolvedPlan = this.getPlanFromPriceId(priceId);
          if (resolvedPlan) {
            plan = resolvedPlan;
          }
        }
        const period = this.resolveBillingPeriod(subscription);
        subscriptionPeriodStart = period.start;
        subscriptionPeriodEnd = period.end;
      } catch (error) {
        this.logger.warn(
          `Failed to get subscription details for invoice: ${error.message}`,
        );
      }
    }

    const currency = (invoice.currency?.toLowerCase() || 'usd') as
      | 'usd'
      | 'mxn';
    const amount = invoice.amount_paid || 0;

    // Calculate MXN amount
    let amountMxn = amount / 100;
    let exchangeRate = 1;
    if (currency === 'usd') {
      try {
        const conversion = await this.exchangeRateService.convertUsdToMxn(
          amount / 100,
          this.firestoreService,
        );
        amountMxn = conversion.amountMxn;
        exchangeRate = conversion.rate;
      } catch (error) {
        this.logger.warn(`Failed to get exchange rate: ${error.message}`);
        exchangeRate = 20;
        amountMxn = (amount / 100) * exchangeRate;
      }
    }

    // Determine transaction type
    const transactionType =
      billingReason === 'subscription_cycle' ? 'renewal' : 'upgrade';

    // Save transaction record
    const transactionId = this.generateTransactionId();
    const transaction: StripeTransaction = {
      id: transactionId,
      stripeEventId: invoice.id || '',
      stripeEventType: 'invoice.payment_succeeded',
      userId: user.id,
      userEmail: user.email,
      amount,
      currency,
      amountMxn,
      exchangeRate,
      type: transactionType,
      plan,
      stripeCustomerId: customerId,
      stripeSubscriptionId: user.stripeSubscriptionId || undefined,
      stripeInvoiceId: invoice.id || undefined,
      status: 'succeeded',
      billingCountry: user.country,
      createdAt: new Date(),
    };

    await this.firestoreService.saveTransaction(transaction);
    this.logger.log(
      `Saved ${transactionType} transaction: ${transactionId} for user ${user.id}`,
    );

    // Update user's billing period dates
    if (subscriptionPeriodStart && subscriptionPeriodEnd) {
      await this.firestoreService.updateUser(user.id, {
        subscriptionPeriodStart,
        subscriptionPeriodEnd,
      });
      this.logger.log(
        `Updated billing period for user ${user.id}: ${subscriptionPeriodStart.toISOString()} - ${subscriptionPeriodEnd.toISOString()}`,
      );
    }

    // Save subscription event for renewal tracking
    if (billingReason === 'subscription_cycle') {
      const subscriptionEvent: SubscriptionEvent = {
        id: this.generateSubscriptionEventId(),
        userId: user.id,
        userEmail: user.email,
        eventType: 'renewed',
        plan,
        previousPlan: plan,
        currency,
        mrr: amount / 100,
        mrrMxn: amountMxn,
        stripeSubscriptionId: user.stripeSubscriptionId || '',
        country: user.country,
        createdAt: new Date(),
      };

      await this.firestoreService.saveSubscriptionEvent(subscriptionEvent);
      this.logger.log(
        `Saved subscription event: renewed for user ${user.id} (${plan})`,
      );
    }
  }

  /**
   * Detect email language from country code
   */
  private detectLanguageFromCountry(country?: string): string {
    if (!country) return 'en';

    const spanishCountries = [
      'MX',
      'ES',
      'AR',
      'CO',
      'PE',
      'CL',
      'VE',
      'EC',
      'GT',
      'CU',
      'BO',
      'DO',
      'HN',
      'SV',
      'NI',
      'CR',
      'PA',
      'UY',
      'PR',
    ];

    if (spanishCountries.includes(country)) return 'es';

    return 'en';
  }
}
