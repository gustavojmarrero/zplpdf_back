import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import {
  InvoicesResponseDto,
  PaymentMethodsResponseDto,
  SubscriptionResponseDto,
} from './dto/billing.dto.js';

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
      this.logger.warn('Stripe secret key not configured. Billing features disabled.');
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
      this.logger.error(`Error fetching invoices for user ${userId}: ${error.message}`);
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
      const customer = await this.stripe.customers.retrieve(user.stripeCustomerId);

      if (customer.deleted) {
        return { paymentMethods: [], defaultPaymentMethodId: null };
      }

      const defaultPmId =
        typeof customer.invoice_settings?.default_payment_method === 'string'
          ? customer.invoice_settings.default_payment_method
          : customer.invoice_settings?.default_payment_method?.id || null;

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
      this.logger.error(`Error fetching payment methods for user ${userId}: ${error.message}`);
      throw new BadRequestException('Failed to fetch payment methods');
    }
  }

  async getSubscription(userId: string): Promise<SubscriptionResponseDto | null> {
    if (!this.stripe) {
      throw new BadRequestException('Billing system not configured');
    }

    const user = await this.firestoreService.getUserById(userId);

    if (!user?.stripeSubscriptionId) {
      return null;
    }

    try {
      const subscription = await this.stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      const price = subscription.items.data[0]?.price;

      return {
        id: subscription.id,
        status: subscription.status,
        plan: user.plan || 'free',
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: subscription.canceled_at,
        priceAmount: price?.unit_amount || null,
        priceCurrency: price?.currency || null,
        interval: price?.recurring?.interval || null,
      };
    } catch (error) {
      this.logger.error(`Error fetching subscription for user ${userId}: ${error.message}`);
      // If subscription not found in Stripe, return null
      if (error.code === 'resource_missing') {
        return null;
      }
      throw new BadRequestException('Failed to fetch subscription');
    }
  }
}
