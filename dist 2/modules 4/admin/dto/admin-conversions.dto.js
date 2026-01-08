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
import { IsOptional, IsDateString, IsEnum } from "class-validator";
export class GetConversionsQueryDto {
    constructor(){
        this.period = 'week';
    }
}
_ts_decorate([
    ApiPropertyOptional({
        enum: [
            'day',
            'week',
            'month'
        ],
        default: 'week'
    }),
    IsOptional(),
    IsEnum([
        'day',
        'week',
        'month'
    ]),
    _ts_metadata("design:type", String)
], GetConversionsQueryDto.prototype, "period", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Start date (ISO 8601)'
    }),
    IsOptional(),
    IsDateString(),
    _ts_metadata("design:type", String)
], GetConversionsQueryDto.prototype, "startDate", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'End date (ISO 8601)'
    }),
    IsOptional(),
    IsDateString(),
    _ts_metadata("design:type", String)
], GetConversionsQueryDto.prototype, "endDate", void 0);
let ConversionsSummaryDto = class ConversionsSummaryDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsSummaryDto.prototype, "totalPdfs", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsSummaryDto.prototype, "totalLabels", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsSummaryDto.prototype, "successCount", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsSummaryDto.prototype, "failureCount", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ConversionsSummaryDto.prototype, "avgLabelsPerPdf", void 0);
let TrendItemDto = class TrendItemDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], TrendItemDto.prototype, "date", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], TrendItemDto.prototype, "pdfs", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], TrendItemDto.prototype, "labels", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], TrendItemDto.prototype, "failures", void 0);
let PlanStatsDto = class PlanStatsDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PlanStatsDto.prototype, "pdfs", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PlanStatsDto.prototype, "labels", void 0);
let TopUserDto = class TopUserDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], TopUserDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], TopUserDto.prototype, "email", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], TopUserDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], TopUserDto.prototype, "pdfs", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], TopUserDto.prototype, "labels", void 0);
let ConversionsDataDto = class ConversionsDataDto {
};
_ts_decorate([
    ApiProperty({
        type: ConversionsSummaryDto
    }),
    _ts_metadata("design:type", typeof ConversionsSummaryDto === "undefined" ? Object : ConversionsSummaryDto)
], ConversionsDataDto.prototype, "summary", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            TrendItemDto
        ]
    }),
    _ts_metadata("design:type", Array)
], ConversionsDataDto.prototype, "trend", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Object)
], ConversionsDataDto.prototype, "byPlan", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            TopUserDto
        ]
    }),
    _ts_metadata("design:type", Array)
], ConversionsDataDto.prototype, "topUsers", void 0);
export class AdminConversionsResponseDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], AdminConversionsResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        type: ConversionsDataDto
    }),
    _ts_metadata("design:type", typeof ConversionsDataDto === "undefined" ? Object : ConversionsDataDto)
], AdminConversionsResponseDto.prototype, "data", void 0);

//# sourceMappingURL=admin-conversions.dto.js.map