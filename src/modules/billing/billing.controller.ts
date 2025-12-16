import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { BillingService } from './billing.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import {
  InvoicesResponseDto,
  PaymentMethodsResponseDto,
  SubscriptionResponseDto,
} from './dto/billing.dto.js';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
@UseGuards(FirebaseAuthGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('invoices')
  @ApiOperation({ summary: 'Get user invoices from Stripe' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max invoices to return (default: 10)' })
  @ApiResponse({
    status: 200,
    description: 'List of invoices',
    type: InvoicesResponseDto,
  })
  async getInvoices(
    @CurrentUser() user: FirebaseUser,
    @Query('limit') limit?: string,
  ): Promise<InvoicesResponseDto> {
    const parsedLimit = limit ? parseInt(limit, 10) : 10;
    return this.billingService.getInvoices(user.uid, parsedLimit);
  }

  @Get('payment-methods')
  @ApiOperation({ summary: 'Get user payment methods from Stripe' })
  @ApiResponse({
    status: 200,
    description: 'List of payment methods',
    type: PaymentMethodsResponseDto,
  })
  async getPaymentMethods(
    @CurrentUser() user: FirebaseUser,
  ): Promise<PaymentMethodsResponseDto> {
    return this.billingService.getPaymentMethods(user.uid);
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Get user subscription details from Stripe' })
  @ApiResponse({
    status: 200,
    description: 'Subscription details',
    type: SubscriptionResponseDto,
  })
  async getSubscription(
    @CurrentUser() user: FirebaseUser,
  ): Promise<SubscriptionResponseDto | null> {
    return this.billingService.getSubscription(user.uid);
  }
}
