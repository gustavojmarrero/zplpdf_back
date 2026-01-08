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
export class UserProfileDto {
}
_ts_decorate([
    ApiProperty({
        description: 'User ID (Firebase UID)'
    }),
    _ts_metadata("design:type", String)
], UserProfileDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty({
        description: 'User email'
    }),
    _ts_metadata("design:type", String)
], UserProfileDto.prototype, "email", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Display name',
        required: false
    }),
    _ts_metadata("design:type", String)
], UserProfileDto.prototype, "displayName", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Whether the email is verified'
    }),
    _ts_metadata("design:type", Boolean)
], UserProfileDto.prototype, "emailVerified", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Current plan',
        enum: [
            'free',
            'pro',
            'enterprise'
        ]
    }),
    _ts_metadata("design:type", typeof PlanType === "undefined" ? Object : PlanType)
], UserProfileDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Account creation date'
    }),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], UserProfileDto.prototype, "createdAt", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Has active Stripe subscription'
    }),
    _ts_metadata("design:type", Boolean)
], UserProfileDto.prototype, "hasStripeSubscription", void 0);

//# sourceMappingURL=user-profile.dto.js.map