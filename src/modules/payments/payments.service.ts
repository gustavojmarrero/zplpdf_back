import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { CheckoutResponseDto, PortalResponseDto } from './dto/create-checkout.dto.js';
import { GA4Service } from '../analytics/ga4.service.js';
import { ExchangeRateService } from '../admin/services/exchange-rate.service.js';
import type { StripeTransaction, SubscriptionEvent } from '../../common/interfaces/finance.interface.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private stripe: Stripe;
  private proPriceId: string;
  private proPriceIdMxn: string;
  private readonly MAX_RETRIES = 3;

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
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }
    throw new Error(`${operationName} failed after ${this.MAX_RETRIES} attempts`);
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly firestoreService: FirestoreService,
    private readonly ga4Service: GA4Service,
    private readonly exchangeRateService: ExchangeRateService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    const nodeEnv = this.configService.get<string>('NODE_ENV');

    if (!stripeSecretKey) {
      this.logger.warn('Stripe secret key not configured. Payment features disabled.');
      return;
    }

    // Validate test vs live key based on environment
    if (nodeEnv === 'production' && stripeSecretKey.startsWith('sk_test_')) {
      this.logger.error('CRITICAL: Using Stripe TEST key in PRODUCTION environment!');
      throw new Error('FATAL: Using Stripe test key in production! Check STRIPE_SECRET_KEY configuration.');
    }

    if (nodeEnv !== 'production' && stripeSecretKey.startsWith('sk_live_')) {
      this.logger.warn('WARNING: Using Stripe LIVE key in non-production environment');
    }

    this.stripe = new Stripe(stripeSecretKey);

    this.proPriceId = this.configService.get<string>('STRIPE_PRO_PRICE_ID');
    this.proPriceIdMxn = this.configService.get<string>('STRIPE_PRO_PRICE_ID_MXN');

    // Validate price ID is configured
    if (!this.proPriceId) {
      this.logger.warn('STRIPE_PRO_PRICE_ID not configured');
    }
    if (!this.proPriceIdMxn) {
      this.logger.warn('STRIPE_PRO_PRICE_ID_MXN not configured');
    }
  }

  async createCheckoutSession(
    userId: string,
    email: string,
    successUrl: string,
    cancelUrl: string,
    country?: string,
  ): Promise<CheckoutResponseDto> {
    if (!this.stripe) {
      throw new BadRequestException('Payment system not configured');
    }

    // Select price based on country
    const priceId = country === 'MX' ? this.proPriceIdMxn : this.proPriceId;

    if (!priceId) {
      throw new BadRequestException('Pro price not configured');
    }

    // Get or create Stripe customer
    const user = await this.firestoreService.getUserById(userId);
    let customerId = user?.stripeCustomerId;

    // Verify customer exists in current Stripe mode (test/live)
    if (customerId) {
      try {
        await this.stripe.customers.retrieve(customerId);
      } catch (error) {
        // Customer doesn't exist in current mode, create new one
        this.logger.warn(`Customer ${customerId} not found in current Stripe mode, creating new one`);
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

  async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const userId = session.metadata?.firebaseUid;

    if (!userId) {
      this.logger.error('No firebaseUid in session metadata');
      return;
    }

    const subscriptionId = session.subscription as string;
    const user = await this.firestoreService.getUserById(userId);
    const billingCountry = session.customer_details?.address?.country || undefined;
    const currency = (session.currency?.toLowerCase() || 'usd') as 'usd' | 'mxn';
    const amount = session.amount_total || 0;

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

    // Update user to Pro plan with retry
    const updateData: Record<string, unknown> = {
      plan: 'pro',
      stripeSubscriptionId: subscriptionId,
    };

    // Update country from billing address if available and not already set
    if (billingCountry && (!user?.country || user.countrySource === 'ip')) {
      updateData.country = billingCountry;
      updateData.countrySource = 'stripe';
      updateData.countryDetectedAt = new Date();
      this.logger.log(`Updated user ${userId} country to ${billingCountry} from Stripe billing`);
    }

    await this.withRetry(
      () => this.firestoreService.updateUser(userId, updateData),
      `handleCheckoutCompleted(${userId})`,
    );

    this.logger.log(`User ${userId} upgraded to Pro plan`);

    // Determine transaction type based on previous plan
    const previousPlan = user?.plan || 'free';
    const transactionType = previousPlan === 'free' ? 'subscription' : 'upgrade';

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
      plan: 'pro',
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
      plan: 'pro',
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
    await this.ga4Service.trackPurchase({
      userId,
      transactionId: session.id,
      planId: 'plan_pro',
      planName: 'Plan Pro',
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

  async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const user = await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId}`);
      return;
    }

    // Check subscription status with retry
    if (subscription.status === 'active') {
      await this.withRetry(
        () => this.firestoreService.updateUser(user.id, {
          plan: 'pro',
          stripeSubscriptionId: subscription.id,
        }),
        `handleSubscriptionUpdated(${user.id})`,
      );
      this.logger.log(`Subscription updated for user ${user.id}: active`);
    } else if (['canceled', 'unpaid', 'past_due'].includes(subscription.status)) {
      await this.withRetry(
        () => this.firestoreService.updateUser(user.id, {
          plan: 'free',
          stripeSubscriptionId: null,
        }),
        `handleSubscriptionUpdated(${user.id})`,
      );
      this.logger.log(`Subscription updated for user ${user.id}: ${subscription.status}`);
    }
  }

  async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const user = await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId}`);
      return;
    }

    // Downgrade to free plan with retry
    await this.withRetry(
      () => this.firestoreService.updateUser(user.id, {
        plan: 'free',
        stripeSubscriptionId: null,
      }),
      `handleSubscriptionDeleted(${user.id})`,
    );

    this.logger.log(`User ${user.id} downgraded to Free plan`);

    // Save subscription event for churn tracking
    const subscriptionEvent: SubscriptionEvent = {
      id: this.generateSubscriptionEventId(),
      userId: user.id,
      userEmail: user.email,
      eventType: 'canceled',
      plan: 'pro',
      previousPlan: 'pro',
      currency: 'usd', // Default, actual currency not available in deleted event
      mrr: 0,
      mrrMxn: 0,
      stripeSubscriptionId: subscription.id,
      cancellationReason: subscription.cancellation_details?.reason || undefined,
      country: user.country,
      createdAt: new Date(),
    };

    await this.firestoreService.saveSubscriptionEvent(subscriptionEvent);
    this.logger.log(`Saved subscription event: canceled for user ${user.id}`);
  }

  async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string;
    const user = await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId} on payment failed`);
      return;
    }

    // Log the failed payment
    this.logger.warn(`Payment failed for user ${user.id}, invoice: ${invoice.id}`);

    // If this is not the first attempt and subscription is past_due, notify
    const attemptCount = invoice.attempt_count || 1;
    if (attemptCount >= 2) {
      this.logger.warn(`Multiple payment failures (${attemptCount}) for user ${user.id}`);
      // TODO: Implement email notification to user about failed payment
    }

    // Note: Don't immediately downgrade - Stripe will retry and send subscription.updated
    // if the final retry fails. This handler is for logging and notifications only.
  }

  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const billingReason = invoice.billing_reason;

    // Skip subscription_create - already handled by checkout.session.completed
    if (billingReason === 'subscription_create') {
      this.logger.log(`Skipping invoice ${invoice.id}: subscription_create handled by checkout`);
      return;
    }

    // Only process renewals (subscription_cycle) and updates (subscription_update)
    if (!['subscription_cycle', 'subscription_update'].includes(billingReason || '')) {
      this.logger.log(`Skipping invoice ${invoice.id}: billing_reason=${billingReason}`);
      return;
    }

    const customerId = invoice.customer as string;
    const user = await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId} on invoice paid`);
      return;
    }

    const currency = (invoice.currency?.toLowerCase() || 'usd') as 'usd' | 'mxn';
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
    const transactionType = billingReason === 'subscription_cycle' ? 'renewal' : 'upgrade';

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
      plan: 'pro',
      stripeCustomerId: customerId,
      stripeSubscriptionId: user.stripeSubscriptionId || undefined,
      stripeInvoiceId: invoice.id || undefined,
      status: 'succeeded',
      billingCountry: user.country,
      createdAt: new Date(),
    };

    await this.firestoreService.saveTransaction(transaction);
    this.logger.log(`Saved ${transactionType} transaction: ${transactionId} for user ${user.id}`);

    // Save subscription event for renewal tracking
    if (billingReason === 'subscription_cycle') {
      const subscriptionEvent: SubscriptionEvent = {
        id: this.generateSubscriptionEventId(),
        userId: user.id,
        userEmail: user.email,
        eventType: 'renewed',
        plan: 'pro',
        previousPlan: 'pro',
        currency,
        mrr: amount / 100,
        mrrMxn: amountMxn,
        stripeSubscriptionId: user.stripeSubscriptionId || '',
        country: user.country,
        createdAt: new Date(),
      };

      await this.firestoreService.saveSubscriptionEvent(subscriptionEvent);
      this.logger.log(`Saved subscription event: renewed for user ${user.id}`);
    }
  }
}
