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
export class PlanLimitsDto {
}
_ts_decorate([
    ApiProperty({
        description: 'Maximum labels per PDF'
    }),
    _ts_metadata("design:type", Number)
], PlanLimitsDto.prototype, "maxLabelsPerPdf", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Maximum PDFs per month'
    }),
    _ts_metadata("design:type", Number)
], PlanLimitsDto.prototype, "maxPdfsPerMonth", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Can download images (PNG/JPEG) - Pro and Enterprise only'
    }),
    _ts_metadata("design:type", Boolean)
], PlanLimitsDto.prototype, "canDownloadImages", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Batch processing allowed - Pro and Enterprise only'
    }),
    _ts_metadata("design:type", Boolean)
], PlanLimitsDto.prototype, "batchAllowed", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Maximum files per batch'
    }),
    _ts_metadata("design:type", Number)
], PlanLimitsDto.prototype, "maxFilesPerBatch", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Maximum file size in bytes for batch'
    }),
    _ts_metadata("design:type", Number)
], PlanLimitsDto.prototype, "maxFileSizeBytes", void 0);
export class CurrentUsageDto {
}
_ts_decorate([
    ApiProperty({
        description: 'PDFs generated this period'
    }),
    _ts_metadata("design:type", Number)
], CurrentUsageDto.prototype, "pdfCount", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Total labels generated this period'
    }),
    _ts_metadata("design:type", Number)
], CurrentUsageDto.prototype, "labelCount", void 0);
export class UserLimitsDto {
}
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
], UserLimitsDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Plan limits',
        type: PlanLimitsDto
    }),
    _ts_metadata("design:type", typeof PlanLimitsDto === "undefined" ? Object : PlanLimitsDto)
], UserLimitsDto.prototype, "limits", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Current usage',
        type: CurrentUsageDto
    }),
    _ts_metadata("design:type", typeof CurrentUsageDto === "undefined" ? Object : CurrentUsageDto)
], UserLimitsDto.prototype, "currentUsage", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Period end date'
    }),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], UserLimitsDto.prototype, "periodEndsAt", void 0);

//# sourceMappingURL=user-limits.dto.js.map