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
let PlanDistributionItemDto = class PlanDistributionItemDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PlanDistributionItemDto.prototype, "users", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PlanDistributionItemDto.prototype, "percentage", void 0);
let UserNearLimitDto = class UserNearLimitDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UserNearLimitDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UserNearLimitDto.prototype, "email", void 0);
_ts_decorate([
    ApiProperty({
        enum: [
            'free',
            'pro',
            'enterprise'
        ]
    }),
    _ts_metadata("design:type", String)
], UserNearLimitDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UserNearLimitDto.prototype, "pdfCount", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UserNearLimitDto.prototype, "pdfLimit", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UserNearLimitDto.prototype, "percentUsed", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], UserNearLimitDto.prototype, "periodEnd", void 0);
let UserExceedingFrequentlyDto = class UserExceedingFrequentlyDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UserExceedingFrequentlyDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UserExceedingFrequentlyDto.prototype, "email", void 0);
_ts_decorate([
    ApiProperty({
        enum: [
            'free',
            'pro',
            'enterprise'
        ]
    }),
    _ts_metadata("design:type", String)
], UserExceedingFrequentlyDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UserExceedingFrequentlyDto.prototype, "exceedCount", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], UserExceedingFrequentlyDto.prototype, "lastExceeded", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UserExceedingFrequentlyDto.prototype, "suggestedPlan", void 0);
let UpgradeOpportunitiesDto = class UpgradeOpportunitiesDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UpgradeOpportunitiesDto.prototype, "freeToProCandidates", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UpgradeOpportunitiesDto.prototype, "proToEnterpriseCandidates", void 0);
let ConversionRatesDto = class ConversionRatesDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionRatesDto.prototype, "freeTrialToPro", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionRatesDto.prototype, "proToEnterprise", void 0);
let PlanUsageDataDto = class PlanUsageDataDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Object)
], PlanUsageDataDto.prototype, "distribution", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            UserNearLimitDto
        ]
    }),
    _ts_metadata("design:type", Array)
], PlanUsageDataDto.prototype, "usersNearLimit", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            UserExceedingFrequentlyDto
        ]
    }),
    _ts_metadata("design:type", Array)
], PlanUsageDataDto.prototype, "usersExceedingFrequently", void 0);
_ts_decorate([
    ApiProperty({
        type: UpgradeOpportunitiesDto
    }),
    _ts_metadata("design:type", typeof UpgradeOpportunitiesDto === "undefined" ? Object : UpgradeOpportunitiesDto)
], PlanUsageDataDto.prototype, "upgradeOpportunities", void 0);
_ts_decorate([
    ApiProperty({
        type: ConversionRatesDto
    }),
    _ts_metadata("design:type", typeof ConversionRatesDto === "undefined" ? Object : ConversionRatesDto)
], PlanUsageDataDto.prototype, "conversionRates", void 0);
export class AdminPlanUsageResponseDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], AdminPlanUsageResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        type: PlanUsageDataDto
    }),
    _ts_metadata("design:type", typeof PlanUsageDataDto === "undefined" ? Object : PlanUsageDataDto)
], AdminPlanUsageResponseDto.prototype, "data", void 0);

//# sourceMappingURL=admin-plan-usage.dto.js.map