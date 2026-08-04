import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import {
  InvoicesResponseDto,
  PaymentMethodsResponseDto,
  SubscriptionResponseDto,
} from './dto/billing.dto.js';
import {
  TaxProfileResponseDto,
  UpdateTaxProfileDto,
} from './dto/tax-profile.dto.js';
import {
  RFC_EXTRANJERO,
  RFC_PUBLICO_GENERAL,
  RFC_REGEX,
  SAT_CFDI_USES,
  SAT_FISCAL_REGIMES,
  getSatPersonType,
  isCfdiUseValidForPerson,
  isRegimeValidForPerson,
} from '../../common/interfaces/tax-profile.interface.js';
import type {
  TaxProfile,
  TaxProfileType,
} from '../../common/interfaces/tax-profile.interface.js';
import { ErrorCodes } from '../../common/constants/error-codes.js';

/**
 * Errores de validación por campo del perfil fiscal.
 *
 * El valor es un **código estable**, no una frase: la app sirve en cuatro
 * idiomas y el backend no conoce el del receptor. La traducción vive en el
 * frontend, igual que se acordó para `cfdi.error.code`.
 */
type TaxProfileFieldErrors = Partial<
  Record<
    | 'type'
    | 'rfc'
    | 'legalName'
    | 'taxRegime'
    | 'postalCode'
    | 'cfdiUse'
    | 'billingEmail'
    | 'taxIdType'
    | 'taxIdValue'
    | 'address',
    string
  >
>;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly firestoreService: FirestoreService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');

    if (!stripeSecretKey) {
      this.logger.warn(
        'Stripe secret key not configured. Billing features disabled.',
      );
      return;
    }

    this.stripe = new Stripe(stripeSecretKey);
  }

  async getInvoices(userId: string, limit = 10): Promise<InvoicesResponseDto> {
    if (!this.stripe) {
      throw new BadRequestException('Billing system not configured');
    }

    const user = await this.firestoreService.getUserById(userId);

    if (!user?.stripeCustomerId) {
      return { invoices: [], hasMore: false };
    }

    try {
      const invoices = await this.stripe.invoices.list({
        customer: user.stripeCustomerId,
        limit,
      });

      return {
        invoices: invoices.data.map((inv) => ({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          amountDue: inv.amount_due,
          amountPaid: inv.amount_paid,
          currency: inv.currency,
          created: inv.created,
          periodStart: inv.period_start,
          periodEnd: inv.period_end,
          hostedInvoiceUrl: inv.hosted_invoice_url,
          invoicePdf: inv.invoice_pdf,
          description: inv.description,
        })),
        hasMore: invoices.has_more,
      };
    } catch (error) {
      this.logger.error(
        `Error fetching invoices for user ${userId}: ${error.message}`,
      );
      throw new BadRequestException('Failed to fetch invoices');
    }
  }

  async getPaymentMethods(userId: string): Promise<PaymentMethodsResponseDto> {
    if (!this.stripe) {
      throw new BadRequestException('Billing system not configured');
    }

    const user = await this.firestoreService.getUserById(userId);

    if (!user?.stripeCustomerId) {
      return { paymentMethods: [], defaultPaymentMethodId: null };
    }

    try {
      const customer = await this.stripe.customers.retrieve(
        user.stripeCustomerId,
      );

      if (customer.deleted) {
        return { paymentMethods: [], defaultPaymentMethodId: null };
      }

      // Cast to Customer type since we verified it's not deleted
      const activeCustomer = customer as Stripe.Customer;
      const defaultPmId =
        typeof activeCustomer.invoice_settings?.default_payment_method ===
        'string'
          ? activeCustomer.invoice_settings.default_payment_method
          : activeCustomer.invoice_settings?.default_payment_method?.id || null;

      const paymentMethods = await this.stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        type: 'card',
      });

      return {
        paymentMethods: paymentMethods.data.map((pm) => ({
          id: pm.id,
          type: pm.type,
          card: {
            brand: pm.card?.brand || 'unknown',
            last4: pm.card?.last4 || '****',
            expMonth: pm.card?.exp_month || 0,
            expYear: pm.card?.exp_year || 0,
          },
          billingDetails: {
            name: pm.billing_details?.name || null,
            email: pm.billing_details?.email || null,
          },
          isDefault: pm.id === defaultPmId,
        })),
        defaultPaymentMethodId: defaultPmId,
      };
    } catch (error) {
      this.logger.error(
        `Error fetching payment methods for user ${userId}: ${error.message}`,
      );
      throw new BadRequestException('Failed to fetch payment methods');
    }
  }

  async getSubscription(
    userId: string,
  ): Promise<SubscriptionResponseDto | null> {
    if (!this.stripe) {
      throw new BadRequestException('Billing system not configured');
    }

    const user = await this.firestoreService.getUserById(userId);

    if (!user?.stripeSubscriptionId) {
      return null;
    }

    try {
      const subscription = (await this.stripe.subscriptions.retrieve(
        user.stripeSubscriptionId,
      )) as Stripe.Subscription;
      const subscriptionItem = subscription.items.data[0];
      const price = subscriptionItem?.price;

      return {
        id: subscription.id,
        status: subscription.status,
        plan: user.plan || 'free',
        currentPeriodStart:
          subscriptionItem?.current_period_start || subscription.start_date,
        currentPeriodEnd: subscriptionItem?.current_period_end || null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: subscription.canceled_at,
        priceAmount: price?.unit_amount || null,
        priceCurrency: price?.currency || null,
        interval: price?.recurring?.interval || null,
      };
    } catch (error) {
      this.logger.error(
        `Error fetching subscription for user ${userId}: ${error.message}`,
      );
      // If subscription not found in Stripe, return null
      if (error.code === 'resource_missing') {
        return null;
      }
      throw new BadRequestException('Failed to fetch subscription');
    }
  }

  // ============== Perfil fiscal ==============

  /**
   * Devuelve el perfil fiscal del usuario.
   *
   * Nunca 404: un perfil vacío es un estado válido, y el frontend necesita el
   * `type` para saber qué formulario renderizar antes de que haya datos.
   */
  async getTaxProfile(userId: string): Promise<TaxProfileResponseDto> {
    const user = await this.firestoreService.getUserById(userId);
    const country = user?.country || '';
    const type = this.resolveProfileType(country);

    const profile = await this.firestoreService.getTaxProfile(userId);

    if (!profile) {
      return { type, country, isComplete: false };
    }

    // El país manda sobre lo guardado: si el usuario se mudó, el formulario que
    // toca es el del país actual, aunque el perfil viejo siga en Firestore.
    if (profile.type !== type) {
      this.logger.warn(
        `Perfil fiscal de ${userId} es '${profile.type}' pero el país es '${country}' ('${type}'). Se pide recargar el perfil.`,
      );
      return { type, country, isComplete: false };
    }

    return this.toResponse(profile, type, country);
  }

  /**
   * Crea o actualiza el perfil fiscal y lo propaga al customer de Stripe.
   *
   * La propagación a Stripe es lo que hace que el PDF que Stripe ya genera salga
   * con la razón social, el domicilio y el tax ID del cliente — todo el alcance
   * del flujo internacional.
   */
  async updateTaxProfile(
    userId: string,
    dto: UpdateTaxProfileDto,
  ): Promise<TaxProfileResponseDto> {
    const user = await this.firestoreService.getUserById(userId);
    const country = user?.country || '';
    const type = this.resolveProfileType(country);

    // El `type` lo decide el país, no el cliente: si el body pudiera elegirlo,
    // un usuario mexicano se saltaría el CFDI declarándose internacional.
    if (dto.type !== type) {
      this.throwFieldErrors({ type: 'type_does_not_match_country' });
    }

    const errors =
      type === 'mx'
        ? this.validateMxProfile(dto)
        : this.validateInternationalProfile(dto);

    if (Object.keys(errors).length > 0) {
      this.throwFieldErrors(errors);
    }

    const existing = await this.firestoreService.getTaxProfile(userId);

    const profile: Partial<TaxProfile> =
      type === 'mx'
        ? {
            type,
            country,
            rfc: dto.rfc.trim().toUpperCase(),
            legalName: this.normalizeLegalName(dto.legalName),
            taxRegime: dto.taxRegime.trim(),
            postalCode: dto.postalCode.trim(),
            cfdiUse: dto.cfdiUse.trim(),
            billingEmail: dto.billingEmail.trim(),
            isComplete: true,
          }
        : {
            type,
            country,
            legalName: dto.legalName.trim(),
            billingEmail: dto.billingEmail.trim(),
            taxIdType: dto.taxIdType?.trim() || null,
            taxIdValue: dto.taxIdValue?.trim() || null,
            address: {
              line1: dto.address.line1.trim(),
              line2: dto.address.line2?.trim() || null,
              city: dto.address.city.trim(),
              state: dto.address.state?.trim() || null,
              postalCode: dto.address.postalCode.trim(),
              country: dto.address.country.trim().toUpperCase(),
            },
            postalCode: dto.address.postalCode.trim(),
            isComplete: true,
          };

    // Si cambia el RFC, el cliente dado de alta en Facturama deja de valer.
    if (type === 'mx' && existing?.rfc && existing.rfc !== profile.rfc) {
      profile.facturamaClientId = null;
    }

    await this.firestoreService.saveTaxProfile(userId, profile);

    // Un fallo propagando a Stripe no debe perder los datos que el usuario acaba
    // de escribir: el perfil ya está guardado y la sincronización se reintenta
    // sola en el siguiente guardado o al completarse un checkout.
    await this.syncTaxProfileToStripe(userId);

    const saved = await this.firestoreService.getTaxProfile(userId);
    return this.toResponse(saved, type, country);
  }

  /**
   * Propaga el perfil fiscal al customer de Stripe. Idempotente y silenciosa.
   *
   * Se invoca al guardar el perfil y también al completarse un checkout, porque
   * un usuario puede cargar sus datos fiscales antes de tener customer: sin el
   * segundo disparo, su primera factura saldría sin ellos.
   */
  async syncTaxProfileToStripe(userId: string): Promise<void> {
    if (!this.stripe) {
      return;
    }

    try {
      const [user, profile] = await Promise.all([
        this.firestoreService.getUserById(userId),
        this.firestoreService.getTaxProfile(userId),
      ]);

      if (!profile?.isComplete) {
        return;
      }

      if (!user?.stripeCustomerId) {
        this.logger.log(
          `Perfil fiscal de ${userId} sin customer de Stripe todavía; se propagará al completar el checkout.`,
        );
        return;
      }

      const address =
        profile.type === 'mx'
          ? { postal_code: profile.postalCode, country: 'MX' }
          : {
              line1: profile.address?.line1,
              line2: profile.address?.line2 || undefined,
              city: profile.address?.city,
              state: profile.address?.state || undefined,
              postal_code: profile.address?.postalCode,
              country: profile.address?.country,
            };

      await this.stripe.customers.update(user.stripeCustomerId, {
        name: profile.legalName,
        email: profile.billingEmail,
        address,
      });

      await this.syncStripeTaxId(userId, user.stripeCustomerId, profile);

      this.logger.log(`Perfil fiscal propagado a Stripe: ${userId}`);
    } catch (error) {
      // No relanzamos: el perfil ya está persistido y este paso solo afecta a
      // cómo se imprime el PDF de Stripe, no a la validez del dato.
      this.logger.error(
        `Error propagando el perfil fiscal de ${userId} a Stripe: ${error.message}`,
      );
    }
  }

  /**
   * Registra el tax ID en Stripe.
   *
   * Stripe no permite modificar un tax ID existente, así que el cambio de valor
   * obliga a borrar el anterior y crear uno nuevo.
   */
  private async syncStripeTaxId(
    userId: string,
    customerId: string,
    profile: TaxProfile,
  ): Promise<void> {
    const type = profile.type === 'mx' ? 'mx_rfc' : profile.taxIdType;
    const value = profile.type === 'mx' ? profile.rfc : profile.taxIdValue;

    if (!type || !value) {
      return;
    }

    const existingTaxIds = await this.stripe.customers.listTaxIds(customerId, {
      limit: 100,
    });
    const alreadyRegistered = existingTaxIds.data.find(
      (taxId) => taxId.type === type && taxId.value === value,
    );

    if (alreadyRegistered) {
      if (profile.stripeTaxIdId !== alreadyRegistered.id) {
        await this.firestoreService.saveTaxProfile(userId, {
          stripeTaxIdId: alreadyRegistered.id,
        });
      }
      return;
    }

    // Los tax IDs obsoletos se borran para que Stripe no imprima dos en el PDF.
    for (const stale of existingTaxIds.data) {
      await this.stripe.customers.deleteTaxId(customerId, stale.id);
    }

    const created = await this.stripe.customers.createTaxId(customerId, {
      type: type as Stripe.TaxIdCreateParams.Type,
      value,
    });

    await this.firestoreService.saveTaxProfile(userId, {
      stripeTaxIdId: created.id,
    });
  }

  /** México usa CFDI; cualquier otro país (o país desconocido) va por Stripe. */
  private resolveProfileType(country: string): TaxProfileType {
    return country?.toUpperCase() === 'MX' ? 'mx' : 'international';
  }

  /**
   * Reglas fiscales que no caben en decoradores de class-validator.
   *
   * No se valida contra el SAT aquí —no hay un endpoint fiable para eso— sino la
   * coherencia interna del perfil, que es lo que causa la mayoría de los rechazos
   * al timbrar: un régimen de persona moral con un RFC de persona física, o un
   * uso de CFDI deducible personal en una empresa.
   */
  private validateMxProfile(dto: UpdateTaxProfileDto): TaxProfileFieldErrors {
    const errors: TaxProfileFieldErrors = {};

    const rfc = dto.rfc?.trim().toUpperCase() ?? '';
    const person = getSatPersonType(rfc);

    if (!RFC_REGEX.test(rfc) || !person) {
      errors.rfc = 'rfc_invalid_format';
    } else if (rfc === RFC_PUBLICO_GENERAL || rfc === RFC_EXTRANJERO) {
      // Los RFC genéricos no identifican a un contribuyente: una factura contra
      // ellos no le sirve al usuario para deducir.
      errors.rfc = 'rfc_generic_not_allowed';
    }

    if (!/^[0-9]{5}$/.test(dto.postalCode?.trim() ?? '')) {
      errors.postalCode = 'postal_code_invalid';
    }

    // Se distingue "no existe en el catálogo" de "existe pero no aplica a este
    // tipo de persona": el frontend pinta mensajes distintos y la acción del
    // usuario también lo es (elegir otro valor vs. revisar su RFC).
    const taxRegime = dto.taxRegime?.trim() ?? '';
    if (!SAT_FISCAL_REGIMES[taxRegime]) {
      errors.taxRegime = 'tax_regime_unknown';
    } else if (person && !isRegimeValidForPerson(taxRegime, person)) {
      errors.taxRegime = 'tax_regime_not_valid_for_person_type';
    }

    const cfdiUse = dto.cfdiUse?.trim() ?? '';
    if (!SAT_CFDI_USES[cfdiUse]) {
      errors.cfdiUse = 'cfdi_use_unknown';
    } else if (person && !isCfdiUseValidForPerson(cfdiUse, person)) {
      errors.cfdiUse = 'cfdi_use_not_valid_for_person_type';
    }

    if (!dto.legalName?.trim()) {
      errors.legalName = 'legal_name_required';
    }

    return errors;
  }

  private validateInternationalProfile(
    dto: UpdateTaxProfileDto,
  ): TaxProfileFieldErrors {
    const errors: TaxProfileFieldErrors = {};

    if (!dto.legalName?.trim()) {
      errors.legalName = 'legal_name_required';
    }

    if (!dto.address?.line1?.trim() || !dto.address?.city?.trim()) {
      errors.address = 'address_incomplete';
    } else if (!/^[A-Z]{2}$/.test(dto.address.country?.trim().toUpperCase())) {
      errors.address = 'address_country_invalid';
    }

    // Un tipo sin valor (o al revés) deja un tax ID a medias que Stripe rechaza.
    const hasType = Boolean(dto.taxIdType?.trim());
    const hasValue = Boolean(dto.taxIdValue?.trim());
    if (hasType !== hasValue) {
      if (hasType) {
        errors.taxIdValue = 'tax_id_value_required';
      } else {
        errors.taxIdType = 'tax_id_type_required';
      }
    }

    return errors;
  }

  /**
   * CFDI 4.0 exige la razón social tal como está registrada ante el SAT, que la
   * guarda en mayúsculas y sin acentos. Normalizarlo aquí evita rechazos por una
   * diferencia puramente ortográfica.
   */
  private normalizeLegalName(legalName: string): string {
    return legalName
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .toUpperCase();
  }

  private throwFieldErrors(errors: TaxProfileFieldErrors): never {
    throw new BadRequestException({
      error: ErrorCodes.INVALID_INPUT,
      message: 'Tax profile validation failed',
      errors,
    });
  }

  private toResponse(
    profile: TaxProfile,
    type: TaxProfileType,
    country: string,
  ): TaxProfileResponseDto {
    const base = {
      type,
      country,
      isComplete: profile.isComplete === true,
      legalName: profile.legalName,
      billingEmail: profile.billingEmail,
      updatedAt:
        profile.updatedAt instanceof Date
          ? profile.updatedAt.toISOString()
          : profile.updatedAt,
    };

    if (type === 'mx') {
      return {
        ...base,
        rfc: profile.rfc,
        taxRegime: profile.taxRegime,
        postalCode: profile.postalCode,
        cfdiUse: profile.cfdiUse,
      };
    }

    return {
      ...base,
      taxIdType: profile.taxIdType ?? null,
      taxIdValue: profile.taxIdValue ?? null,
      address: profile.address ?? null,
    };
  }
}
