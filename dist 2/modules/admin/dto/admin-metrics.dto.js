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
let RecentRegistrationDto = class RecentRegistrationDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], RecentRegistrationDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], RecentRegistrationDto.prototype, "email", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], RecentRegistrationDto.prototype, "displayName", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], RecentRegistrationDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], RecentRegistrationDto.prototype, "createdAt", void 0);
let UsersMetricsDto = class UsersMetricsDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UsersMetricsDto.prototype, "total", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UsersMetricsDto.prototype, "activeToday", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UsersMetricsDto.prototype, "activeWeek", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UsersMetricsDto.prototype, "activeMonth", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Object)
], UsersMetricsDto.prototype, "byPlan", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            RecentRegistrationDto
        ]
    }),
    _ts_metadata("design:type", Array)
], UsersMetricsDto.prototype, "recentRegistrations", void 0);
let ConversionTrendDto = class ConversionTrendDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], ConversionTrendDto.prototype, "date", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionTrendDto.prototype, "count", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionTrendDto.prototype, "labels", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionTrendDto.prototype, "failures", void 0);
let ConversionsMetricsDto = class ConversionsMetricsDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsMetricsDto.prototype, "pdfsToday", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsMetricsDto.prototype, "pdfsWeek", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsMetricsDto.prototype, "pdfsMonth", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsMetricsDto.prototype, "pdfsTotal", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsMetricsDto.prototype, "labelsToday", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsMetricsDto.prototype, "labelsTotal", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsMetricsDto.prototype, "successRate", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsMetricsDto.prototype, "failureRate", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            ConversionTrendDto
        ]
    }),
    _ts_metadata("design:type", Array)
], ConversionsMetricsDto.prototype, "trend", void 0);
let ErrorContextDto = class ErrorContextDto {
};
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", Number)
], ErrorContextDto.prototype, "line", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], ErrorContextDto.prototype, "command", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", Number)
], ErrorContextDto.prototype, "input_length", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", Number)
], ErrorContextDto.prototype, "label_count", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", Number)
], ErrorContextDto.prototype, "elapsed_ms", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], ErrorContextDto.prototype, "service", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], ErrorContextDto.prototype, "error_code", void 0);
let RecentErrorDto = class RecentErrorDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], RecentErrorDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], RecentErrorDto.prototype, "type", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], RecentErrorDto.prototype, "code", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], RecentErrorDto.prototype, "message", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], RecentErrorDto.prototype, "userId", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], RecentErrorDto.prototype, "userEmail", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], RecentErrorDto.prototype, "jobId", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], RecentErrorDto.prototype, "timestamp", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], RecentErrorDto.prototype, "severity", void 0);
_ts_decorate([
    ApiProperty({
        type: ErrorContextDto,
        required: false
    }),
    _ts_metadata("design:type", typeof ErrorContextDto === "undefined" ? Object : ErrorContextDto)
], RecentErrorDto.prototype, "context", void 0);
let ErrorsMetricsDto = class ErrorsMetricsDto {
};
_ts_decorate([
    ApiProperty({
        type: [
            RecentErrorDto
        ]
    }),
    _ts_metadata("design:type", Array)
], ErrorsMetricsDto.prototype, "recentErrors", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Record === "undefined" ? Object : Record)
], ErrorsMetricsDto.prototype, "byType", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ErrorsMetricsDto.prototype, "criticalCount", void 0);
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
    ApiProperty(),
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
    ApiProperty(),
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
let PlanUsageMetricsDto = class PlanUsageMetricsDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Object)
], PlanUsageMetricsDto.prototype, "distribution", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            UserNearLimitDto
        ]
    }),
    _ts_metadata("design:type", Array)
], PlanUsageMetricsDto.prototype, "usersNearLimit", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            UserExceedingFrequentlyDto
        ]
    }),
    _ts_metadata("design:type", Array)
], PlanUsageMetricsDto.prototype, "usersExceedingFrequently", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Object)
], PlanUsageMetricsDto.prototype, "upgradeOpportunities", void 0);
let MetricsDataDto = class MetricsDataDto {
};
_ts_decorate([
    ApiProperty({
        type: UsersMetricsDto
    }),
    _ts_metadata("design:type", typeof UsersMetricsDto === "undefined" ? Object : UsersMetricsDto)
], MetricsDataDto.prototype, "users", void 0);
_ts_decorate([
    ApiProperty({
        type: ConversionsMetricsDto
    }),
    _ts_metadata("design:type", typeof ConversionsMetricsDto === "undefined" ? Object : ConversionsMetricsDto)
], MetricsDataDto.prototype, "conversions", void 0);
_ts_decorate([
    ApiProperty({
        type: ErrorsMetricsDto
    }),
    _ts_metadata("design:type", typeof ErrorsMetricsDto === "undefined" ? Object : ErrorsMetricsDto)
], MetricsDataDto.prototype, "errors", void 0);
_ts_decorate([
    ApiProperty({
        type: PlanUsageMetricsDto
    }),
    _ts_metadata("design:type", typeof PlanUsageMetricsDto === "undefined" ? Object : PlanUsageMetricsDto)
], MetricsDataDto.prototype, "planUsage", void 0);
export class AdminMetricsResponseDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], AdminMetricsResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        type: MetricsDataDto
    }),
    _ts_metadata("design:type", typeof MetricsDataDto === "undefined" ? Object : MetricsDataDto)
], AdminMetricsResponseDto.prototype, "data", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], AdminMetricsResponseDto.prototype, "generatedAt", void 0);

//# sourceMappingURL=admin-metrics.dto.js.map