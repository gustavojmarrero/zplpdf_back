import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentsService } from '../payments/payments.service.js';
import { CfdiService } from '../billing/cfdi.service.js';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private stripe: Stripe;
  private webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
    private readonly cfdiService: CfdiService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    this.webhookSecret = this.configService.get<string>(
      'STRIPE_WEBHOOK_SECRET',
    );

    if (!stripeSecretKey) {
      this.logger.warn('Stripe secret key not configured. Webhooks disabled.');
      return;
    }

    this.stripe = new Stripe(stripeSecretKey);
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
    if (!this.stripe || !this.webhookSecret) {
      throw new BadRequestException('Webhook not configured');
    }

    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (err) {
      this.logger.error(
        `Webhook signature verification failed: ${err.message}`,
      );
      throw new BadRequestException('Invalid webhook signature');
    }

    this.logger.log(`Received Stripe event: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.paymentsService.handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session,
        );
        break;

      case 'customer.subscription.updated':
        await this.paymentsService.handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        );
        break;

      case 'customer.subscription.deleted':
        await this.paymentsService.handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        );
        break;

      case 'invoice.payment_failed':
        await this.paymentsService.handlePaymentFailed(
          event.data.object as Stripe.Invoice,
        );
        break;

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;

        // El CFDI va aparte de `handleInvoicePaid` y antes que él a propósito.
        // Aquel descarta `billing_reason: 'subscription_create'` porque el alta
        // la resuelve `checkout.session.completed`, así que colgar de él el
        // timbrado dejaría sin comprobante el primer cobro de cada cliente
        // —justo el que más reclaman—. Fiscalmente se factura todo cobro, sea
        // alta, renovación o cambio de plan.
        await this.cfdiService.stampForInvoice(invoice);

        await this.paymentsService.handleInvoicePaid(invoice);
        break;
      }

      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }
  }
}
