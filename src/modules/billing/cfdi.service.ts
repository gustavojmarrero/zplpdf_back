import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FacturamaService } from '../facturama/facturama.service.js';
import {
  CFDI_PAYMENT_FORM_CREDIT_CARD,
  CFDI_PAYMENT_FORM_DEBIT_CARD,
  CfdiErrorCodes,
  type CfdiErrorCode,
} from '../facturama/facturama.constants.js';
import {
  FacturamaError,
  type StampResult,
} from '../facturama/interfaces/facturama.interface.js';
import type { Cfdi } from '../../common/interfaces/cfdi.interface.js';
import type { TaxProfile } from '../../common/interfaces/tax-profile.interface.js';
import type { User } from '../../common/interfaces/user.interface.js';

/**
 * Emisión de CFDI 4.0 por los cobros de suscripción.
 *
 * Vive separado de `FacturamaService` a propósito: aquel es el cliente HTTP del
 * PAC y este decide *si* un cobro lleva comprobante, con qué datos, y qué hacer
 * cuando el timbrado falla.
 */
@Injectable()
export class CfdiService {
  private readonly logger = new Logger(CfdiService.name);
  /** Solo se usa para resolver el tipo de tarjeta del cobro. */
  private readonly stripe: Stripe | null = null;

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly facturamaService: FacturamaService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeSecretKey) {
      this.stripe = new Stripe(stripeSecretKey);
    }
  }

  /**
   * Timbra el CFDI de una factura pagada. **Nunca lanza.**
   *
   * Se invoca desde el webhook de Stripe, que debe responder 200 pase lo que
   * pase: un rechazo del PAC no puede reintentar el evento ni tocar el estado de
   * la suscripción. El fallo se persiste con su código y el usuario lo reintenta
   * desde la app cuando corrige sus datos.
   */
  async stampForInvoice(invoice: Stripe.Invoice): Promise<void> {
    try {
      await this.stampForInvoiceOrThrow(invoice);
    } catch (error) {
      this.logger.error(
        `Error no controlado timbrando la factura ${invoice?.id}: ${error?.message}`,
        error?.stack,
      );
    }
  }

  private async stampForInvoiceOrThrow(invoice: Stripe.Invoice): Promise<void> {
    const stripeInvoiceId = invoice.id;
    const amountPaid = invoice.amount_paid ?? 0;

    // Una factura de importe cero (cupón al 100 %, prueba gratuita) no ampara
    // ningún ingreso y no se comprueba fiscalmente.
    if (amountPaid <= 0) {
      return;
    }

    const customerId = invoice.customer as string;
    const user =
      await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.warn(
        `Factura ${stripeInvoiceId} sin usuario asociado al customer ${customerId}; no se timbra`,
      );
      return;
    }

    if (user.country?.toUpperCase() !== 'MX') {
      // El resto del mundo se factura con el PDF de Stripe, que ya lleva los
      // datos fiscales del perfil.
      return;
    }

    const profile = await this.firestoreService.getTaxProfile(user.id);

    if (!profile?.isComplete || profile.type !== 'mx') {
      this.logger.log(
        `Usuario ${user.id} sin perfil fiscal completo; la factura ${stripeInvoiceId} queda sin CFDI`,
      );
      return;
    }

    const amount = amountPaid / 100;
    const currency = (invoice.currency || 'mxn').toLowerCase();

    // La reserva es el candado de idempotencia: si otro intento ya la tiene, no
    // se timbra por segunda vez.
    const reserved = await this.firestoreService.reserveCfdi({
      stripeInvoiceId,
      userId: user.id,
      amount,
      currency,
    });

    if (!reserved) {
      return;
    }

    await this.stamp(invoice, user, profile, {
      amount,
      currency,
      attempts: reserved.attempts,
    });
  }

  /**
   * Reintenta el timbrado de un CFDI que quedó en `failed`.
   *
   * A diferencia de `stampForInvoice`, aquí sí se propaga el error: hay un
   * usuario esperando la respuesta y necesita saber si su corrección funcionó.
   *
   * Recibe el perfil y los intentos ya resueltos por quien tomó el candado, en
   * vez de releerlos. Entre el candado y el PAC no puede quedar ninguna lectura
   * que pueda fallar: en ese tramo el documento ya está en `pending`, así que
   * cualquier error previo a llamar a Facturama lo dejaría clavado en ese estado
   * y bloquearía todos los reintentos posteriores. Quien reserva, valida.
   */
  async retry(
    invoice: Stripe.Invoice,
    user: User,
    profile: TaxProfile,
    previousAttempts: number,
  ): Promise<Cfdi> {
    await this.stamp(
      invoice,
      user,
      profile,
      {
        amount: (invoice.amount_paid ?? 0) / 100,
        currency: (invoice.currency || 'mxn').toLowerCase(),
        attempts: previousAttempts,
      },
      { rethrow: true },
    );

    return this.firestoreService.getCfdiByInvoiceId(invoice.id);
  }

  /**
   * Timbra y persiste el resultado.
   *
   * El PDF y el XML se copian a Cloud Storage porque el comprobante debe
   * conservarse cinco años y depender del PAC para siempre es una dependencia
   * que no controlamos. Que esa copia falle no invalida el CFDI: ya está
   * timbrado ante el SAT, así que se registra igualmente como `stamped` y solo
   * se pierden los enlaces de descarga.
   */
  private async stamp(
    invoice: Stripe.Invoice,
    user: User,
    profile: TaxProfile,
    money: { amount: number; currency: string; attempts: number },
    options: { rethrow?: boolean } = {},
  ): Promise<void> {
    const stripeInvoiceId = invoice.id;
    // Los intentos previos los trae quien tomó el documento. Releerlos aquí
    // añadía una operación de Firestore fuera de todo manejo de error, con el
    // CFDI ya en `pending`: un fallo transitorio lo dejaba clavado en ese estado
    // sin haber llamado siquiera al PAC, bloqueando todo reintento posterior.
    const attempts = money.attempts + 1;

    // Los precios en MXN son finales y el CFDI los desglosa hacia atrás. Un
    // cobro en otra divisa necesitaría TipoCambio, y emitirlo como si fuera
    // pesos declararía un importe que no es el cobrado.
    if (money.currency !== 'mxn') {
      const message = `El cobro se hizo en ${money.currency.toUpperCase()} y el CFDI solo se emite en MXN`;
      this.logger.error(
        `Factura ${stripeInvoiceId} del usuario ${user.id}: ${message}`,
      );
      await this.persistFailure(
        stripeInvoiceId,
        attempts,
        CfdiErrorCodes.INVOICE_NOT_STAMPABLE,
        message,
      );
      if (options.rethrow) {
        throw new FacturamaError(CfdiErrorCodes.INVOICE_NOT_STAMPABLE, message);
      }
      return;
    }

    // El try cubre EXCLUSIVAMENTE la llamada al PAC. Todo lo que viene después
    // ocurre con un comprobante ya emitido ante el SAT, y ahí `failed` es una
    // mentira peligrosa: habilita un reintento que emitiría un duplicado.
    let result: StampResult;
    try {
      result = await this.facturamaService.stampSubscription({
        receiver: {
          Rfc: profile.rfc,
          Name: profile.legalName,
          CfdiUse: profile.cfdiUse,
          FiscalRegime: profile.taxRegime,
          TaxZipCode: profile.postalCode,
        },
        total: money.amount,
        currency: money.currency,
        description: this.buildDescription(invoice, user),
        paymentForm: await this.resolvePaymentForm(invoice),
        chargedAt: this.resolveChargedAt(invoice),
      });
    } catch (error) {
      const code =
        error instanceof FacturamaError ? error.code : CfdiErrorCodes.UNKNOWN;
      const message =
        error instanceof Error ? error.message : 'Error desconocido';

      this.logger.error(
        `Fallo al timbrar la factura ${stripeInvoiceId} (usuario ${user.id}) [${code}]: ${message}`,
      );

      await this.persistFailure(stripeInvoiceId, attempts, code, message);

      if (options.rethrow) {
        throw error;
      }
      return;
    }

    // A partir de aquí el CFDI existe. Se registra antes de archivar nada, para
    // que la ventana en la que el UUID solo vive en memoria sea la mínima.
    await this.persistStamped(stripeInvoiceId, {
      status: 'stamped',
      uuid: result.uuid,
      facturamaId: result.facturamaId,
      stampedAt: result.stampedAt,
      attempts,
      error: null,
      userId: user.id,
      amount: money.amount,
      currency: money.currency,
    });

    this.logger.log(
      `CFDI timbrado para la factura ${stripeInvoiceId} (usuario ${user.id}): ${result.uuid}`,
    );

    const paths = await this.archiveDocuments(
      result.facturamaId,
      user.id,
      stripeInvoiceId,
    );

    if (paths.pdfPath || paths.xmlPath) {
      try {
        await this.firestoreService.updateCfdi(stripeInvoiceId, paths);
      } catch (error) {
        // Solo se pierden los enlaces de descarga; el comprobante sigue en pie.
        this.logger.error(
          `CFDI ${result.uuid} archivado, pero no se pudieron guardar sus rutas: ${error.message}`,
        );
      }
    }
  }

  /**
   * Registra el CFDI como timbrado, reintentando la escritura.
   *
   * Es el único punto donde perder una escritura tiene consecuencias fiscales:
   * el comprobante ya existe ante el SAT y el UUID solo vive en esta variable.
   * Si aun con reintentos no se persiste, el documento se queda en `pending` —un
   * estado que el reintento manual rechaza— y se deja constancia del UUID en el
   * log para reconciliarlo a mano. Nunca `failed`: eso invitaría a duplicarlo.
   */
  private async persistStamped(
    stripeInvoiceId: string,
    data: Partial<Cfdi>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.firestoreService.updateCfdi(stripeInvoiceId, data);
        return;
      } catch (error) {
        if (attempt === 3) {
          this.logger.error(
            `CRÍTICO: CFDI timbrado que no se pudo registrar. Factura ${stripeInvoiceId}, UUID ${data.uuid}, Facturama ${data.facturamaId}. Queda en 'pending' y necesita reconciliación manual. Último error: ${error.message}`,
          );
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * Math.pow(2, attempt - 1)),
        );
      }
    }
  }

  private async persistFailure(
    stripeInvoiceId: string,
    attempts: number,
    code: CfdiErrorCode,
    message: string,
  ): Promise<void> {
    await this.firestoreService.updateCfdi(stripeInvoiceId, {
      status: 'failed',
      attempts,
      error: { code, message },
    });
  }

  /**
   * Copia el PDF y el XML a Cloud Storage.
   *
   * Devuelve las rutas guardadas, o un objeto vacío si la copia falla: el
   * comprobante ya existe ante el SAT y perder los enlaces es recuperable, marcar
   * el CFDI como fallido cuando sí se timbró no lo es —llevaría a emitir un
   * duplicado al reintentar.
   */
  private async archiveDocuments(
    facturamaId: string,
    userId: string,
    stripeInvoiceId: string,
  ): Promise<{ pdfPath?: string; xmlPath?: string }> {
    try {
      const [pdf, xml] = await Promise.all([
        this.facturamaService.downloadPdf(facturamaId),
        this.facturamaService.downloadXml(facturamaId),
      ]);

      const pdfPath = `cfdis/${userId}/${stripeInvoiceId}.pdf`;
      const xmlPath = `cfdis/${userId}/${stripeInvoiceId}.xml`;

      await Promise.all([
        this.storageService.saveFile(pdfPath, pdf, 'application/pdf'),
        this.storageService.saveFile(xmlPath, xml, 'application/xml'),
      ]);

      return { pdfPath, xmlPath };
    } catch (error) {
      this.logger.error(
        `CFDI de ${stripeInvoiceId} timbrado, pero falló el archivado de PDF/XML: ${error.message}`,
      );
      return {};
    }
  }

  /**
   * Texto del concepto.
   *
   * Incluye el periodo facturado porque es lo que distingue una mensualidad de
   * la siguiente en la contabilidad del cliente.
   */
  private buildDescription(invoice: Stripe.Invoice, user: User): string {
    const plan = (user.plan || 'pro').toUpperCase();
    const line = invoice.lines?.data?.[0];
    const start = line?.period?.start ?? invoice.period_start;
    const end = line?.period?.end ?? invoice.period_end;

    if (!start || !end) {
      return `Suscripción ZPLPDF Plan ${plan}`;
    }

    return `Suscripción ZPLPDF Plan ${plan} — periodo ${this.formatDate(start)} a ${this.formatDate(end)}`;
  }

  private formatDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toLocaleDateString('es-MX', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'America/Mexico_City',
    });
  }

  /**
   * Distingue tarjeta de crédito (04) de débito (28) en c_FormaPago.
   *
   * En el webhook `payment_intent` llega como id sin expandir, así que mirar el
   * objeto de la factura resolvía «crédito» siempre y todo cobro con débito se
   * timbraba con una clave fiscal que no corresponde. Se recupera el intent
   * expandiendo el método de pago: una llamada extra por CFDI es irrelevante al
   * volumen de este servicio y es la única forma de saberlo.
   *
   * Si no se puede averiguar, crédito: es la clave habitual para un cobro con
   * tarjeta y no hay una opción neutra en el catálogo.
   */
  private async resolvePaymentForm(invoice: Stripe.Invoice): Promise<string> {
    const funding = await this.resolveCardFunding(invoice);

    if (!funding) {
      this.logger.warn(
        `No se pudo determinar el tipo de tarjeta de la factura ${invoice.id}; se timbra como crédito (04)`,
      );
    }

    return funding === 'debit'
      ? CFDI_PAYMENT_FORM_DEBIT_CARD
      : CFDI_PAYMENT_FORM_CREDIT_CARD;
  }

  private async resolveCardFunding(
    invoice: Stripe.Invoice,
  ): Promise<string | null> {
    if (!this.stripe) {
      return null;
    }

    try {
      const intent = await this.resolvePaymentIntent(invoice);

      if (!intent) {
        return null;
      }

      // Ya expandido: el objeto trae el método de pago dentro.
      if (typeof intent !== 'string') {
        const funding = this.readFunding(intent);
        if (funding) {
          return funding;
        }
      }

      const intentId = typeof intent === 'string' ? intent : intent.id;
      const retrieved = await this.stripe.paymentIntents.retrieve(intentId, {
        expand: ['payment_method'],
      });

      return this.readFunding(retrieved);
    } catch (error) {
      // Un fallo aquí no puede impedir el timbrado: la factura se emite igual
      // con la clave por defecto.
      this.logger.warn(
        `No se pudo recuperar el método de pago de ${invoice.id}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Localiza el PaymentIntent de la factura.
   *
   * Desde la versión de API `2025-03-31.basil`, `Invoice` ya no expone
   * `payment_intent` en el nivel superior: los cobros viven en `payments`, una
   * lista de InvoicePayment donde el intent está en `payment.payment_intent`.
   * Leer el campo viejo devolvía `undefined` siempre, y con él toda tarjeta de
   * débito se habría timbrado como crédito.
   */
  private async resolvePaymentIntent(
    invoice: Stripe.Invoice,
  ): Promise<string | Stripe.PaymentIntent | null> {
    const fromInvoice = this.pickIntentFromPayments(invoice.payments?.data);
    if (fromInvoice) {
      return fromInvoice;
    }

    // `payments` no viaja expandido en el evento del webhook.
    const listed = await this.stripe.invoicePayments.list({
      invoice: invoice.id,
      limit: 10,
    });

    return this.pickIntentFromPayments(listed.data);
  }

  private pickIntentFromPayments(
    payments: Stripe.InvoicePayment[] | undefined,
  ): string | Stripe.PaymentIntent | null {
    if (!payments?.length) {
      return null;
    }

    // Una factura puede acumular intentos fallidos antes del que cobró; el que
    // describe fiscalmente la operación es el que tuvo éxito.
    const paid =
      payments.find((payment) => payment.status === 'paid') ?? payments[0];

    return paid?.payment?.type === 'payment_intent'
      ? (paid.payment.payment_intent ?? null)
      : null;
  }

  private readFunding(intent: Stripe.PaymentIntent): string | null {
    const method = intent.payment_method;

    return typeof method === 'object' && method !== null
      ? (method.card?.funding ?? null)
      : null;
  }

  private resolveChargedAt(invoice: Stripe.Invoice): Date | undefined {
    const paidAt = invoice.status_transitions?.paid_at;
    return paidAt ? new Date(paidAt * 1000) : undefined;
  }
}
