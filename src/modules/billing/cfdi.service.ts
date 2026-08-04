import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FacturamaService } from '../facturama/facturama.service.js';
import {
  CFDI_PAYMENT_FORM_CREDIT_CARD,
  CFDI_PAYMENT_FORM_DEBIT_CARD,
  CfdiErrorCodes,
  type CfdiErrorCode,
} from '../facturama/facturama.constants.js';
import { FacturamaError } from '../facturama/interfaces/facturama.interface.js';
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

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly facturamaService: FacturamaService,
    private readonly storageService: StorageService,
  ) {}

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

    await this.stamp(invoice, user, profile, { amount, currency });
  }

  /**
   * Reintenta el timbrado de un CFDI que quedó en `failed`.
   *
   * A diferencia de `stampForInvoice`, aquí sí se propaga el error: hay un
   * usuario esperando la respuesta y necesita saber si su corrección funcionó.
   */
  async retry(invoice: Stripe.Invoice, user: User): Promise<Cfdi> {
    const profile = await this.firestoreService.getTaxProfile(user.id);

    if (!profile?.isComplete || profile.type !== 'mx') {
      throw new FacturamaError(
        CfdiErrorCodes.INVOICE_NOT_STAMPABLE,
        'El perfil fiscal está incompleto',
      );
    }

    await this.stamp(
      invoice,
      user,
      profile,
      {
        amount: (invoice.amount_paid ?? 0) / 100,
        currency: (invoice.currency || 'mxn').toLowerCase(),
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
    money: { amount: number; currency: string },
    options: { rethrow?: boolean } = {},
  ): Promise<void> {
    const stripeInvoiceId = invoice.id;
    const existing =
      await this.firestoreService.getCfdiByInvoiceId(stripeInvoiceId);
    const attempts = (existing?.attempts ?? 0) + 1;

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

    try {
      const result = await this.facturamaService.stampSubscription({
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
        paymentForm: this.resolvePaymentForm(invoice),
        chargedAt: this.resolveChargedAt(invoice),
      });

      const paths = await this.archiveDocuments(
        result.facturamaId,
        user.id,
        stripeInvoiceId,
      );

      await this.firestoreService.updateCfdi(stripeInvoiceId, {
        status: 'stamped',
        uuid: result.uuid,
        facturamaId: result.facturamaId,
        stampedAt: result.stampedAt,
        attempts,
        error: null,
        userId: user.id,
        amount: money.amount,
        currency: money.currency,
        ...paths,
      });

      this.logger.log(
        `CFDI timbrado para la factura ${stripeInvoiceId} (usuario ${user.id}): ${result.uuid}`,
      );
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
   * Distingue tarjeta de crédito de débito en c_FormaPago.
   *
   * Stripe expande `payment_intent` solo bajo petición, así que en el webhook
   * llega como id y no siempre se puede saber. Ante la duda, crédito: es la
   * clave que el SAT acepta por defecto para un cobro con tarjeta.
   */
  private resolvePaymentForm(invoice: Stripe.Invoice): string {
    const intent = (invoice as { payment_intent?: unknown }).payment_intent;

    const funding =
      typeof intent === 'object' && intent !== null
        ? (
            intent as {
              payment_method?: { card?: { funding?: string } };
            }
          ).payment_method?.card?.funding
        : undefined;

    return funding === 'debit'
      ? CFDI_PAYMENT_FORM_DEBIT_CARD
      : CFDI_PAYMENT_FORM_CREDIT_CARD;
  }

  private resolveChargedAt(invoice: Stripe.Invoice): Date | undefined {
    const paidAt = invoice.status_transitions?.paid_at;
    return paidAt ? new Date(paidAt * 1000) : undefined;
  }
}
