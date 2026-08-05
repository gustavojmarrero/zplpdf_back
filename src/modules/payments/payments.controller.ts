import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PaymentsService } from './payments.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import {
  CreateCheckoutDto,
  CheckoutResponseDto,
  PortalResponseDto,
  UpgradeSubscriptionDto,
  UpgradeResponseDto,
} from './dto/create-checkout.dto.js';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
@UseGuards(FirebaseAuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('create-checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create Stripe Checkout session for subscription' })
  @ApiResponse({
    status: 200,
    description: 'Checkout session created',
    type: CheckoutResponseDto,
  })
  async createCheckout(
    @CurrentUser() user: FirebaseUser,
    @Body() dto: CreateCheckoutDto,
  ): Promise<CheckoutResponseDto> {
    const successUrl =
      dto.successUrl ||
      'https://zplpdf.com/success?session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl = dto.cancelUrl || 'https://zplpdf.com/pricing';

    return this.paymentsService.createCheckoutSession(
      user.uid,
      user.email,
      successUrl,
      cancelUrl,
      dto.country,
      dto.plan || 'pro',
    );
  }

  @Post('portal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create Stripe Customer Portal session' })
  @ApiResponse({
    status: 200,
    description: 'Portal session created',
    type: PortalResponseDto,
  })
  async createPortal(
    @CurrentUser() user: FirebaseUser,
    @Body() body: { returnUrl?: string },
  ): Promise<PortalResponseDto> {
    const returnUrl = body.returnUrl || 'https://zplpdf.com/account';

    return this.paymentsService.createPortalSession(user.uid, returnUrl);
  }

  @Post('upgrade')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upgrade subscription from PRO to PRO MAX' })
  @ApiResponse({
    status: 200,
    description: 'Subscription upgraded successfully',
    type: UpgradeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid upgrade request (no subscription, wrong plan, etc.)',
  })
  @ApiResponse({
    status: 409,
    description:
      'Another change to this subscription is already in progress (a concurrent ' +
      'upgrade or an incoming Stripe webhook). Nothing was charged: the request is ' +
      'rejected before touching Stripe. The client should show the returned message ' +
      'and let the user retry in a moment.',
  })
  @ApiResponse({
    status: 503,
    description:
      'Temporarily unavailable. The status alone does NOT tell whether money moved — ' +
      'the client must branch on the `error` code:\n\n' +
      '- `UPGRADE_APPLIED_SYNC_PENDING` (with `data.paymentProcessed: true`): the change ' +
      'went through and WAS CHARGED in Stripe; only confirming it is taking longer than ' +
      'usual, and a webhook syncs the plan shortly after. Never present this as a failed ' +
      'charge or invite the user to pay again.\n' +
      '- Any other code (e.g. `SERVICE_UNAVAILABLE`): nothing was charged, or it could not ' +
      'be determined. These are the tax-profile sync failure and the indeterminate ' +
      'reconciliation. Do not claim a payment was made.',
  })
  async upgradeSubscription(
    @CurrentUser() user: FirebaseUser,
    @Body() dto: UpgradeSubscriptionDto,
  ): Promise<UpgradeResponseDto> {
    return this.paymentsService.upgradeSubscription(user.uid, dto.targetPlan);
  }
}
