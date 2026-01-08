function _ts_decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for(var i = decorators.length - 1; i >= 0; i--)if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function _ts_metadata(k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional } from "class-validator";
export class CreateCheckoutDto {
}
_ts_decorate([
    ApiProperty({
        description: 'URL to redirect after successful checkout',
        required: false
    }),
    IsString(),
    IsOptional(),
    _ts_metadata("design:type", String)
], CreateCheckoutDto.prototype, "successUrl", void 0);
_ts_decorate([
    ApiProperty({
        description: 'URL to redirect after cancelled checkout',
        required: false
    }),
    IsString(),
    IsOptional(),
    _ts_metadata("design:type", String)
], CreateCheckoutDto.prototype, "cancelUrl", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Country code (ISO 3166-1 alpha-2) for currency selection',
        required: false,
        example: 'MX'
    }),
    IsString(),
    IsOptional(),
    _ts_metadata("design:type", String)
], CreateCheckoutDto.prototype, "country", void 0);
export class CheckoutResponseDto {
}
_ts_decorate([
    ApiProperty({
        description: 'Stripe Checkout URL'
    }),
    _ts_metadata("design:type", String)
], CheckoutResponseDto.prototype, "checkoutUrl", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Stripe Session ID'
    }),
    _ts_metadata("design:type", String)
], CheckoutResponseDto.prototype, "sessionId", void 0);
export class PortalResponseDto {
}
_ts_decorate([
    ApiProperty({
        description: 'Stripe Customer Portal URL'
    }),
    _ts_metadata("design:type", String)
], PortalResponseDto.prototype, "portalUrl", void 0);

//# sourceMappingURL=create-checkout.dto.js.map