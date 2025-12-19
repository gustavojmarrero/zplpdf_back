import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { CheckoutResponseDto, PortalResponseDto } from './dto/create-checkout.dto.js';

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

    // Update user to Pro plan with retry
    await this.withRetry(
      () => this.firestoreService.updateUser(userId, {
        plan: 'pro',
        stripeSubscriptionId: subscriptionId,
      }),
      `handleCheckoutCompleted(${userId})`,
    );

    this.logger.log(`User ${userId} upgraded to Pro plan`);
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
}
