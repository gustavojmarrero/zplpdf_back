import {
  Injectable,
  Logger,
  BadRequestException,
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
import { PLAN_ORDER } from '../../common/interfaces/user.interface.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';
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
    const user = await this.firestoreService.getUserById(userId);

    // VALIDATION: Prevent duplicate subscriptions
    // Check if user already has the same plan
    if (user?.plan === plan) {
      throw new BadRequestException(
        `You are already subscribed to the ${plan.toUpperCase()} plan. Manage your subscription from your account settings.`,
      );
    }

    // Check if user has an active subscription in Stripe (defense in depth)
    if (user?.stripeSubscriptionId) {
      try {
        const existingSubscription = await this.stripe.subscriptions.retrieve(
          user.stripeSubscriptionId,
        );

        if (
          ['active', 'trialing', 'past_due'].includes(
            existingSubscription.status,
          )
        ) {
          // Get the current plan from the subscription
          const currentPriceId = existingSubscription.items.data[0]?.price?.id;
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
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        // Subscription doesn't exist in Stripe (maybe switched test/live mode)
        this.logger.warn(
          `Could not verify subscription ${user.stripeSubscriptionId}: ${error.message}`,
        );
      }
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
   * La acción que resuelve el bloqueo depende del estado: cambiar la tarjeta solo
   * sirve en los estados de cobro (`past_due`, `unpaid`); si la suscripción ya
   * terminó hay que contratarla de nuevo, y en el resto de estados no hay nada que
   * el cliente pueda arreglar por su cuenta.
   */
  private inactiveSubscriptionMessage(status: string): string {
    const base = `Your subscription is not active (status: ${status}).`;

    if (status === 'past_due' || status === 'unpaid') {
      return (
        `${base} Please update your payment method from your account settings ` +
        `before upgrading.`
      );
    }

    if (status === 'canceled' || status === 'incomplete_expired') {
      return `${base} Please subscribe again to get the plan you need.`;
    }

    return `${base} Manage your subscription from your account settings before upgrading.`;
  }

  /** Stripe descarta las claves de idempotencia a las 24 h; no tiene sentido conservarlas más. */
  private static readonly IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

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
    return this.firestoreService.acquireUpgradeIdempotency(
      userId,
      {
        key: `upgrade_${userId}_${randomUUID()}`,
        targetPlan,
        subscriptionId,
      },
      PaymentsService.IDEMPOTENCY_TTL_MS,
    );
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
  ): Promise<{ success: boolean; message: string } | null> {
    const type = (error as { type?: string }).type;
    if (type !== 'StripeConnectionError' && type !== 'StripeAPIError') {
      return null;
    }

    this.logger.warn(
      `Error indeterminado de Stripe (${type}) — ${context}. Releyendo la suscripción ` +
        `para saber si el cambio llegó a aplicarse.`,
    );

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
      this.throwPendingPaymentError(current, context);
    }

    const applied =
      current.status === 'active' &&
      current.items.data.some((item) => item.price?.id === expectedPriceId);

    if (!applied) {
      return null;
    }

    // El cambio sí se aplicó: sincronizamos Firestore para no dejar al cliente
    // pagando un plan que el producto no le reconoce.
    await this.firestoreService.updateUserSubscriptionState(
      userId,
      { plan: targetPlan },
      readAt,
    );
    this.logger.log(
      `Upgrade reconciliado tras error indeterminado: el cambio sí se aplicó — ${context}.`,
    );

    return {
      success: true,
      message: `Successfully upgraded to ${targetPlan.toUpperCase()}. Proration has been applied.`,
    };
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

    if (subscription.status !== 'active') {
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

    const idempotencyKey = await this.getUpgradeIdempotencyKey(
      userId,
      targetPlan,
      user.stripeSubscriptionId,
    );

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
      );
      if (reconciled) {
        // La reconciliación es un desenlace definitivo: se sabe que el cambio
        // se aplicó, así que el próximo intento debe partir de clave nueva.
        await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);
        return reconciled;
      }
      // Solo los errores indeterminados conservan la clave: son los únicos que
      // el cliente debe reintentar con la misma para no arriesgar otro cargo.
      const type = (error as { type?: string }).type;
      if (type !== 'StripeConnectionError' && type !== 'StripeAPIError') {
        await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);
      }
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
    // confirmada como activa.
    if (updatedSubscription.status !== 'active') {
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
    await this.firestoreService.updateUserSubscriptionState(
      userId,
      { plan: targetPlan },
      confirmedAt,
    );
    // La clave se libera aparte y comparando: borrarla en la misma escritura
    // sería incondicional y podría pisar la de un intento posterior.
    await this.clearUpgradeIdempotencyKey(userId, idempotencyKey);

    this.logger.log(
      `User ${userId} upgraded from ${user.plan.toUpperCase()} to ${targetPlan.toUpperCase()}`,
    );

    return {
      success: true,
      message: `Successfully upgraded to ${targetPlan.toUpperCase()}. Proration has been applied.`,
    };
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

    // Log if user already has a different subscription (indicates duplicate checkout)
    if (
      user?.stripeSubscriptionId &&
      user.stripeSubscriptionId !== subscriptionId
    ) {
      this.logger.warn(
        `DUPLICATE CHECKOUT DETECTED: User ${userId} already has subscription ${user.stripeSubscriptionId}. ` +
          `New subscription from checkout: ${subscriptionId}. ` +
          `User plan: ${user.plan}. Previous subscription may be orphaned in Stripe.`,
      );
    }
    const billingCountry =
      session.customer_details?.address?.country || undefined;
    const billingCity = session.customer_details?.address?.city || undefined;
    const currency = (session.currency?.toLowerCase() || 'usd') as
      | 'usd'
      | 'mxn';
    const amount = session.amount_total || 0;

    // Get plan and period from subscription
    let plan: PaidPlanType | null = null;
    let subscriptionPeriodStart: Date | undefined;
    let subscriptionPeriodEnd: Date | undefined;
    try {
      const subscription =
        await this.stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;
      if (priceId) {
        plan = this.getPlanFromPriceId(priceId);
      }
      const period = this.resolveBillingPeriod(subscription);
      subscriptionPeriodStart = period.start;
      subscriptionPeriodEnd = period.end;
    } catch (error) {
      this.logger.warn(`Failed to get subscription details: ${error.message}`);
    }

    // Si no se pudo resolver el plan desde el price ID, NO asignar uno por defecto:
    // hacerlo regalaría un plan (potencialmente superior) por mala configuración.
    // Abortamos y registramos error crítico; Stripe reintentará el webhook.
    if (!plan) {
      this.logger.error(
        `CRITICAL: No se pudo determinar el plan para checkout de user ${userId} ` +
          `(session ${session.id}, sub ${subscriptionId}). Plan NO asignado. Revisar STRIPE_*_PRICE_ID.`,
      );
      throw new Error(`Cannot resolve plan for checkout session ${session.id}`);
    }

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

    // Update user plan with retry
    // IMPORTANT: Only include period fields if they have values - Firestore rejects undefined
    const updateData: Record<string, unknown> = {
      plan,
      stripeSubscriptionId: subscriptionId,
    };
    if (subscriptionPeriodStart) {
      updateData.subscriptionPeriodStart = subscriptionPeriodStart;
    }
    if (subscriptionPeriodEnd) {
      updateData.subscriptionPeriodEnd = subscriptionPeriodEnd;
    }

    // Update country/city from billing address if available and not already set by Stripe
    if (billingCountry && (!user?.country || user.countrySource === 'ip')) {
      updateData.country = billingCountry;
      updateData.city = billingCity;
      updateData.countrySource = 'stripe';
      updateData.countryDetectedAt = new Date();
      this.logger.log(
        `Updated user ${userId} geo to ${billingCountry}/${billingCity || 'unknown'} from Stripe billing`,
      );
    }

    await this.withRetry(
      () => this.firestoreService.updateUser(userId, updateData),
      `handleCheckoutCompleted(${userId})`,
    );

    this.logger.log(`User ${userId} upgraded to ${plan} plan`);

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
   * Devuelve el estado VIGENTE de la suscripción en Stripe.
   *
   * Si Stripe ya no la conoce (`resource_missing`) se usa el snapshot del
   * evento: es lo único que queda y describe una suscripción que desapareció.
   * Cualquier otro fallo se propaga para que el webhook se reintente; escribir
   * el snapshot sin poder confirmarlo sería justo el bug que esto corrige.
   */
  private async fetchCurrentSubscription(
    subscription: Stripe.Subscription,
  ): Promise<Stripe.Subscription> {
    try {
      return await this.stripe.subscriptions.retrieve(subscription.id);
    } catch (error) {
      if ((error as { code?: string }).code === 'resource_missing') {
        this.logger.warn(
          `Stripe ya no conoce la suscripción ${subscription.id}; ` +
            `se aplica el snapshot del evento.`,
        );
        return subscription;
      }
      throw error;
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

    // El snapshot del evento NO es fuente de verdad. Stripe no garantiza el
    // orden de entrega, y el upgrade con `pending_if_incomplete` emite dos
    // eventos: uno con el precio ANTERIOR cuando el cambio queda pendiente de
    // cobro, y otro con el nuevo cuando el pago se confirma. Si el primero se
    // entrega tarde —reintento, latencia, 3DS de por medio— aplicarlo
    // degradaría un plan ya pagado (issue #74). Se relee el estado vigente y se
    // escribe ese, sellado con el instante de la lectura para que una escritura
    // más fresca no pueda ser pisada por otra que leyó antes.
    const readAt = new Date();
    const current = await this.fetchCurrentSubscription(subscription);

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
          ),
        `handleSubscriptionUpdated(${user.id})`,
      );
      this.logger.log(
        applied
          ? `Subscription updated for user ${user.id}: active (${plan})`
          : `Subscription updated descartado para user ${user.id}: el documento ya refleja una lectura posterior`,
      );
    } else if (['canceled', 'unpaid'].includes(current.status)) {
      // Subscription terminated - downgrade to free and clear subscription ID
      const previousPlan = user.plan || 'pro';

      const applied = await this.withRetry(
        () =>
          this.firestoreService.updateUserSubscriptionState(
            user.id,
            {
              plan: 'free',
              stripeSubscriptionId: null,
            },
            readAt,
          ),
        `handleSubscriptionUpdated(${user.id})`,
      );

      // El email va atado a la escritura: avisar de una degradación que se
      // descartó por obsoleta alarmaría a un cliente que sigue de pago.
      if (!applied) {
        this.logger.log(
          `Downgrade descartado para user ${user.id}: el documento ya refleja una lectura posterior`,
        );
        return;
      }

      this.logger.log(
        `Subscription updated for user ${user.id}: ${current.status}`,
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
          previousPlan,
          current.status,
        )
        .catch((err) =>
          this.logger.error(
            `Failed to queue subscription downgraded email: ${err.message}`,
          ),
        );
    } else if (current.status === 'past_due') {
      // Payment pending - keep subscriptionId to allow status queries
      // Don't downgrade immediately, give user time to pay
      // The handlePaymentFailed method already sends notification emails
      await this.withRetry(
        () =>
          this.firestoreService.updateUserSubscriptionState(
            user.id,
            {
              stripeSubscriptionId: current.id,
            },
            readAt,
          ),
        `handleSubscriptionUpdated(${user.id})`,
      );
      this.logger.log(
        `Subscription past_due for user ${user.id} - keeping subscription active for recovery`,
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

    // Get the plan that was canceled (from user's current plan before downgrade)
    const canceledPlan =
      user.plan === 'lite' || user.plan === 'pro' || user.plan === 'promax'
        ? user.plan
        : 'pro';

    // Downgrade to free plan with retry
    await this.withRetry(
      () =>
        this.firestoreService.updateUser(user.id, {
          plan: 'free',
          stripeSubscriptionId: null,
        }),
      `handleSubscriptionDeleted(${user.id})`,
    );

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

    // Log the failed payment
    this.logger.warn(
      `Payment failed for user ${user.id}, invoice: ${invoice.id}`,
    );

    // If this is not the first attempt, send payment failed notification
    const attemptCount = invoice.attempt_count || 1;
    if (attemptCount >= 2) {
      this.logger.warn(
        `Multiple payment failures (${attemptCount}) for user ${user.id}`,
      );
      // Send payment failed notification email
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

    // Note: Don't immediately downgrade - Stripe will retry and send subscription.updated
    // if the final retry fails. This handler is for logging and notifications only.
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
