import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
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
import {
  TaxProfileResponseDto,
  UpdateTaxProfileDto,
} from './dto/tax-profile.dto.js';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
@UseGuards(FirebaseAuthGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('invoices')
  @ApiOperation({ summary: 'Get user invoices from Stripe' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max invoices to return (default: 10)',
  })
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

  @Get('tax-profile')
  @ApiOperation({
    summary: 'Get the tax profile of the authenticated user',
    description:
      'Devuelve `isComplete: false` en lugar de 404 cuando el usuario todavía no ha cargado sus datos. El campo `type` lo deriva el backend de `user.country`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Tax profile (may be empty)',
    type: TaxProfileResponseDto,
  })
  async getTaxProfile(
    @CurrentUser() user: FirebaseUser,
  ): Promise<TaxProfileResponseDto> {
    return this.billingService.getTaxProfile(user.uid);
  }

  @Put('tax-profile')
  @ApiOperation({
    summary: 'Create or update the tax profile',
    description:
      'Persiste el perfil y lo propaga al customer de Stripe (name, address y tax ID) para que el PDF que genera Stripe salga con los datos fiscales del cliente.',
  })
  @ApiResponse({
    status: 200,
    description: 'Saved tax profile',
    type: TaxProfileResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validación fallida. El detalle por campo llega en `data.errors` como códigos estables (p. ej. `rfc_invalid_format`) que el frontend traduce.',
  })
  async updateTaxProfile(
    @CurrentUser() user: FirebaseUser,
    @Body() dto: UpdateTaxProfileDto,
  ): Promise<TaxProfileResponseDto> {
    return this.billingService.updateTaxProfile(user.uid, dto);
  }
}
