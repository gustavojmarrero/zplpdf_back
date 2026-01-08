function _ts_decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for(var i = decorators.length - 1; i >= 0; i--)if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function _ts_metadata(k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
// Invoice DTOs
export class InvoiceDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], InvoiceDto.prototype, "id", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], InvoiceDto.prototype, "number", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], InvoiceDto.prototype, "status", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Amount in cents'
    }),
    _ts_metadata("design:type", Number)
], InvoiceDto.prototype, "amountDue", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Amount in cents'
    }),
    _ts_metadata("design:type", Number)
], InvoiceDto.prototype, "amountPaid", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], InvoiceDto.prototype, "currency", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Unix timestamp'
    }),
    _ts_metadata("design:type", Number)
], InvoiceDto.prototype, "created", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Unix timestamp'
    }),
    _ts_metadata("design:type", Number)
], InvoiceDto.prototype, "periodStart", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Unix timestamp'
    }),
    _ts_metadata("design:type", Number)
], InvoiceDto.prototype, "periodEnd", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], InvoiceDto.prototype, "hostedInvoiceUrl", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], InvoiceDto.prototype, "invoicePdf", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], InvoiceDto.prototype, "description", void 0);
export class InvoicesResponseDto {
}
_ts_decorate([
    ApiProperty({
        type: [
            InvoiceDto
        ]
    }),
    _ts_metadata("design:type", Array)
], InvoicesResponseDto.prototype, "invoices", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], InvoicesResponseDto.prototype, "hasMore", void 0);
// Payment Method DTOs
export class CardDetailsDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], CardDetailsDto.prototype, "brand", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], CardDetailsDto.prototype, "last4", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], CardDetailsDto.prototype, "expMonth", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], CardDetailsDto.prototype, "expYear", void 0);
export class BillingDetailsDto {
}
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], BillingDetailsDto.prototype, "name", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], BillingDetailsDto.prototype, "email", void 0);
export class PaymentMethodDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], PaymentMethodDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], PaymentMethodDto.prototype, "type", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof CardDetailsDto === "undefined" ? Object : CardDetailsDto)
], PaymentMethodDto.prototype, "card", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof BillingDetailsDto === "undefined" ? Object : BillingDetailsDto)
], PaymentMethodDto.prototype, "billingDetails", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], PaymentMethodDto.prototype, "isDefault", void 0);
export class PaymentMethodsResponseDto {
}
_ts_decorate([
    ApiProperty({
        type: [
            PaymentMethodDto
        ]
    }),
    _ts_metadata("design:type", Array)
], PaymentMethodsResponseDto.prototype, "paymentMethods", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], PaymentMethodsResponseDto.prototype, "defaultPaymentMethodId", void 0);
// Subscription DTOs
export class SubscriptionResponseDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], SubscriptionResponseDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], SubscriptionResponseDto.prototype, "status", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], SubscriptionResponseDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Unix timestamp'
    }),
    _ts_metadata("design:type", Number)
], SubscriptionResponseDto.prototype, "currentPeriodStart", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Unix timestamp'
    }),
    _ts_metadata("design:type", Number)
], SubscriptionResponseDto.prototype, "currentPeriodEnd", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], SubscriptionResponseDto.prototype, "cancelAtPeriodEnd", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Unix timestamp'
    }),
    _ts_metadata("design:type", Object)
], SubscriptionResponseDto.prototype, "canceledAt", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Amount in cents'
    }),
    _ts_metadata("design:type", Object)
], SubscriptionResponseDto.prototype, "priceAmount", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], SubscriptionResponseDto.prototype, "priceCurrency", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", Object)
], SubscriptionResponseDto.prototype, "interval", void 0);

//# sourceMappingURL=billing.dto.js.map