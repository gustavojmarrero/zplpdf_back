import { Injectable, Logger, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { CheckoutResponseDto, PortalResponseDto } from './dto/create-checkout.dto.js';
import { GA4Service } from '../analytics/ga4.service.js';
import { ExchangeRateService } from '../admin/services/exchange-rate.service.js';
import { EmailService } from '../email/email.service.js';
import type { StripeTransaction, SubscriptionEvent } from '../../common/interfaces/finance.interface.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';

type PaidPlanType = 'pro' | 'promax' | 'enterprise';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private stripe: Stripe;
  private proPriceId: string;
  private proPriceIdMxn: string;
  private promaxPriceId: string;
  private promaxPriceIdMxn: string;
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
    @Inject(forwardRef(() => EmailService))
    private readonly emailService: EmailService,
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
    this.promaxPriceId = this.configService.get<string>('STRIPE_PROMAX_PRICE_ID');
    this.promaxPriceIdMxn = this.configService.get<string>('STRIPE_PROMAX_PRICE_ID_MXN');

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
  }

  /**
   * Get plan type from Stripe price ID
   */
  private getPlanFromPriceId(priceId: string): PaidPlanType {
    if (priceId === this.proPriceId || priceId === this.proPriceIdMxn) {
      return 'pro';
    }
    if (priceId === this.promaxPriceId || priceId === this.promaxPriceIdMxn) {
      return 'promax';
    }
    // Default to pro for unknown prices (backwards compatibility)
    this.logger.warn(`Unknown price ID: ${priceId}, defaulting to pro`);
    return 'pro';
  }

  /**
   * Get price ID for a plan and country
   */
  private getPriceIdForPlan(plan: 'pro' | 'promax', country?: string): string {
    const isMexico = country === 'MX';
    if (plan === 'promax') {
      return isMexico ? this.promaxPriceIdMxn : this.promaxPriceId;
    }
    return isMexico ? this.proPriceIdMxn : this.proPriceId;
  }

  async createCheckoutSession(
    userId: string,
    email: string,
    successUrl: string,
    cancelUrl: string,
    country?: string,
    plan: 'pro' | 'promax' = 'pro',
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

        if (['active', 'trialing', 'past_due'].includes(existingSubscription.status)) {
          // Get the current plan from the subscription
          const currentPriceId = existingSubscription.items.data[0]?.price?.id;
          const currentPlan = currentPriceId ? this.getPlanFromPriceId(currentPriceId) : 'pro';

          // If trying to buy the same plan, reject
          if (currentPlan === plan) {
            throw new BadRequestException(
              `You already have an active ${plan.toUpperCase()} subscription. Manage it from your account settings.`,
            );
          }

          // If upgrading from pro to promax, redirect to upgrade endpoint
          if (currentPlan === 'pro' && plan === 'promax') {
            throw new BadRequestException(
              'Use the upgrade endpoint to upgrade from PRO to PRO MAX.',
            );
          }

          this.logger.warn(
            `User ${userId} has existing ${currentPlan} subscription ${user.stripeSubscriptionId}, ` +
            `attempting to create checkout for ${plan}`,
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

  /**
   * Upgrade subscription from one paid plan to another (e.g., PRO → PRO MAX)
   * Stripe handles proration automatically
   */
  async upgradeSubscription(
    userId: string,
    targetPlan: 'promax',
  ): Promise<{ success: boolean; message: string }> {
    if (!this.stripe) {
      throw new BadRequestException('Payment system not configured');
    }

    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (!user.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription to upgrade. Please subscribe first.');
    }

    if (user.plan !== 'pro') {
      throw new BadRequestException(`Cannot upgrade from ${user.plan} plan. Only PRO users can upgrade to PRO MAX.`);
    }

    // Get current subscription to find the item ID
    const subscription = await this.stripe.subscriptions.retrieve(user.stripeSubscriptionId);

    if (subscription.status !== 'active') {
      throw new BadRequestException('Subscription is not active');
    }

    const subscriptionItemId = subscription.items.data[0]?.id;
    if (!subscriptionItemId) {
      throw new BadRequestException('Could not find subscription item');
    }

    // Get the new price ID based on user's country
    const newPriceId = this.getPriceIdForPlan(targetPlan, user.country);

    if (!newPriceId) {
      throw new BadRequestException('PRO MAX price not configured');
    }

    // Update subscription with proration
    await this.stripe.subscriptions.update(user.stripeSubscriptionId, {
      items: [
        {
          id: subscriptionItemId,
          price: newPriceId,
        },
      ],
      proration_behavior: 'always_invoice', // Charge/credit immediately
    });

    // Update user plan in Firestore
    await this.firestoreService.updateUser(userId, {
      plan: 'promax',
    });

    this.logger.log(`User ${userId} upgraded from PRO to PRO MAX`);

    return {
      success: true,
      message: 'Successfully upgraded to PRO MAX. Proration has been applied.',
    };
  }

  async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
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
    if (user?.stripeSubscriptionId && user.stripeSubscriptionId !== subscriptionId) {
      this.logger.warn(
        `DUPLICATE CHECKOUT DETECTED: User ${userId} already has subscription ${user.stripeSubscriptionId}. ` +
        `New subscription from checkout: ${subscriptionId}. ` +
        `User plan: ${user.plan}. Previous subscription may be orphaned in Stripe.`,
      );
    }
    const billingCountry = session.customer_details?.address?.country || undefined;
    const billingCity = session.customer_details?.address?.city || undefined;
    const currency = (session.currency?.toLowerCase() || 'usd') as 'usd' | 'mxn';
    const amount = session.amount_total || 0;

    // Get plan and period from subscription
    let plan: PaidPlanType = 'pro';
    let subscriptionPeriodStart: Date | undefined;
    let subscriptionPeriodEnd: Date | undefined;
    try {
      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;
      if (priceId) {
        plan = this.getPlanFromPriceId(priceId);
      }
      // Extract billing period dates (type cast for Stripe API compatibility)
      const periodStart = (subscription as unknown as { current_period_start: number }).current_period_start;
      const periodEnd = (subscription as unknown as { current_period_end: number }).current_period_end;
      if (periodStart) subscriptionPeriodStart = new Date(periodStart * 1000);
      if (periodEnd) subscriptionPeriodEnd = new Date(periodEnd * 1000);
    } catch (error) {
      this.logger.warn(`Failed to get subscription details: ${error.message}`);
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
      this.logger.log(`Updated user ${userId} geo to ${billingCountry}/${billingCity || 'unknown'} from Stripe billing`);
    }

    await this.withRetry(
      () => this.firestoreService.updateUser(userId, updateData),
      `handleCheckoutCompleted(${userId})`,
    );

    this.logger.log(`User ${userId} upgraded to ${plan} plan`);

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

  async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const user = await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId}`);
      return;
    }

    // Get plan from subscription price
    const priceId = subscription.items.data[0]?.price?.id;
    const plan = priceId ? this.getPlanFromPriceId(priceId) : 'pro';

    // Check subscription status with retry
    // Type cast for Stripe API compatibility
    const periodStart = (subscription as unknown as { current_period_start: number }).current_period_start;
    const periodEnd = (subscription as unknown as { current_period_end: number }).current_period_end;

    if (subscription.status === 'active') {
      // IMPORTANT: Only include period fields if they have values - Firestore rejects undefined
      const activeUpdateData: Record<string, unknown> = {
        plan,
        stripeSubscriptionId: subscription.id,
      };
      if (periodStart) {
        activeUpdateData.subscriptionPeriodStart = new Date(periodStart * 1000);
      }
      if (periodEnd) {
        activeUpdateData.subscriptionPeriodEnd = new Date(periodEnd * 1000);
      }
      await this.withRetry(
        () => this.firestoreService.updateUser(user.id, activeUpdateData),
        `handleSubscriptionUpdated(${user.id})`,
      );
      this.logger.log(`Subscription updated for user ${user.id}: active (${plan})`);
    } else if (['canceled', 'unpaid', 'past_due'].includes(subscription.status)) {
      // Capture previous plan before downgrade
      const previousPlan = user.plan || 'pro';

      await this.withRetry(
        () => this.firestoreService.updateUser(user.id, {
          plan: 'free',
          stripeSubscriptionId: null,
        }),
        `handleSubscriptionUpdated(${user.id})`,
      );
      this.logger.log(`Subscription updated for user ${user.id}: ${subscription.status}`);

      // Send downgrade notification email
      this.emailService
        .queueSubscriptionDowngradedEmail({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          language: this.detectLanguageFromCountry(user.country),
        }, previousPlan, subscription.status)
        .catch((err) => this.logger.error(`Failed to queue subscription downgraded email: ${err.message}`));
    }
  }

  async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const user = await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId}`);
      return;
    }

    // Get the plan that was canceled (from user's current plan before downgrade)
    const canceledPlan = (user.plan === 'pro' || user.plan === 'promax') ? user.plan : 'pro';

    // Downgrade to free plan with retry
    await this.withRetry(
      () => this.firestoreService.updateUser(user.id, {
        plan: 'free',
        stripeSubscriptionId: null,
      }),
      `handleSubscriptionDeleted(${user.id})`,
    );

    this.logger.log(`User ${user.id} downgraded to Free plan (was ${canceledPlan})`);

    // Send downgrade notification email
    this.emailService
      .queueSubscriptionDowngradedEmail({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        language: this.detectLanguageFromCountry(user.country),
      }, canceledPlan, 'canceled')
      .catch((err) => this.logger.error(`Failed to queue subscription downgraded email: ${err.message}`));

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

    // If this is not the first attempt, send payment failed notification
    const attemptCount = invoice.attempt_count || 1;
    if (attemptCount >= 2) {
      this.logger.warn(`Multiple payment failures (${attemptCount}) for user ${user.id}`);
      // Send payment failed notification email
      this.emailService
        .queuePaymentFailedEmail({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          language: this.detectLanguageFromCountry(user.country),
        }, attemptCount)
        .catch((err) => this.logger.error(`Failed to queue payment failed email: ${err.message}`));
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

    // Get plan and period from invoice subscription
    let plan: PaidPlanType = (user.plan === 'pro' || user.plan === 'promax') ? user.plan : 'pro';
    let subscriptionPeriodStart: Date | undefined;
    let subscriptionPeriodEnd: Date | undefined;
    const subscriptionId = (invoice as { subscription?: string | null }).subscription as string;
    if (subscriptionId) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0]?.price?.id;
        if (priceId) {
          plan = this.getPlanFromPriceId(priceId);
        }
        // Extract new billing period dates (type cast for Stripe API compatibility)
        const periodStart = (subscription as unknown as { current_period_start: number }).current_period_start;
        const periodEnd = (subscription as unknown as { current_period_end: number }).current_period_end;
        if (periodStart) subscriptionPeriodStart = new Date(periodStart * 1000);
        if (periodEnd) subscriptionPeriodEnd = new Date(periodEnd * 1000);
      } catch (error) {
        this.logger.warn(`Failed to get subscription details for invoice: ${error.message}`);
      }
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
      plan,
      stripeCustomerId: customerId,
      stripeSubscriptionId: user.stripeSubscriptionId || undefined,
      stripeInvoiceId: invoice.id || undefined,
      status: 'succeeded',
      billingCountry: user.country,
      createdAt: new Date(),
    };

    await this.firestoreService.saveTransaction(transaction);
    this.logger.log(`Saved ${transactionType} transaction: ${transactionId} for user ${user.id}`);

    // Update user's billing period dates
    if (subscriptionPeriodStart && subscriptionPeriodEnd) {
      await this.firestoreService.updateUser(user.id, {
        subscriptionPeriodStart,
        subscriptionPeriodEnd,
      });
      this.logger.log(`Updated billing period for user ${user.id}: ${subscriptionPeriodStart.toISOString()} - ${subscriptionPeriodEnd.toISOString()}`);
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
      this.logger.log(`Saved subscription event: renewed for user ${user.id} (${plan})`);
    }
  }

  /**
   * Detect email language from country code
   */
  private detectLanguageFromCountry(country?: string): string {
    if (!country) return 'en';

    const spanishCountries = [
      'MX', 'ES', 'AR', 'CO', 'PE', 'CL', 'VE', 'EC', 'GT', 'CU',
      'BO', 'DO', 'HN', 'SV', 'NI', 'CR', 'PA', 'UY', 'PR',
    ];

    if (spanishCountries.includes(country)) return 'es';

    return 'en';
  }
}
