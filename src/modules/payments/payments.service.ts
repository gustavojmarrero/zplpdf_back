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

  constructor(
    private readonly configService: ConfigService,
    private readonly firestoreService: FirestoreService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');

    if (!stripeSecretKey) {
      this.logger.warn('Stripe secret key not configured. Payment features disabled.');
      return;
    }

    this.stripe = new Stripe(stripeSecretKey);

    this.proPriceId = this.configService.get<string>('STRIPE_PRO_PRICE_ID');
  }

  async createCheckoutSession(
    userId: string,
    email: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<CheckoutResponseDto> {
    if (!this.stripe) {
      throw new BadRequestException('Payment system not configured');
    }

    if (!this.proPriceId) {
      throw new BadRequestException('Pro price not configured');
    }

    // Get or create Stripe customer
    const user = await this.firestoreService.getUserById(userId);
    let customerId = user?.stripeCustomerId;

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
          price: this.proPriceId,
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

    // Update user to Pro plan
    await this.firestoreService.updateUser(userId, {
      plan: 'pro',
      stripeSubscriptionId: subscriptionId,
    });

    this.logger.log(`User ${userId} upgraded to Pro plan`);
  }

  async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const user = await this.firestoreService.getUserByStripeCustomerId(customerId);

    if (!user) {
      this.logger.error(`No user found for customer: ${customerId}`);
      return;
    }

    // Check subscription status
    if (subscription.status === 'active') {
      await this.firestoreService.updateUser(user.id, {
        plan: 'pro',
        stripeSubscriptionId: subscription.id,
      });
      this.logger.log(`Subscription updated for user ${user.id}: active`);
    } else if (['canceled', 'unpaid', 'past_due'].includes(subscription.status)) {
      await this.firestoreService.updateUser(user.id, {
        plan: 'free',
        stripeSubscriptionId: null,
      });
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

    // Downgrade to free plan
    await this.firestoreService.updateUser(user.id, {
      plan: 'free',
      stripeSubscriptionId: null,
    });

    this.logger.log(`User ${user.id} downgraded to Free plan`);
  }
}
