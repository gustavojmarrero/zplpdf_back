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
import { IsOptional, IsString, IsNumber, Min, Max, IsDateString, IsEnum } from "class-validator";
import { Type } from "class-transformer";
export class GetErrorsQueryDto {
    constructor(){
        this.page = 1;
        this.limit = 100;
    }
}
_ts_decorate([
    ApiPropertyOptional({
        default: 1
    }),
    IsOptional(),
    Type(()=>Number),
    IsNumber(),
    Min(1),
    _ts_metadata("design:type", Number)
], GetErrorsQueryDto.prototype, "page", void 0);
_ts_decorate([
    ApiPropertyOptional({
        default: 100,
        maximum: 500
    }),
    IsOptional(),
    Type(()=>Number),
    IsNumber(),
    Min(1),
    Max(500),
    _ts_metadata("design:type", Number)
], GetErrorsQueryDto.prototype, "limit", void 0);
_ts_decorate([
    ApiPropertyOptional({
        enum: [
            'error',
            'warning',
            'critical'
        ]
    }),
    IsOptional(),
    IsEnum([
        'error',
        'warning',
        'critical'
    ]),
    _ts_metadata("design:type", String)
], GetErrorsQueryDto.prototype, "severity", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Filter by error type'
    }),
    IsOptional(),
    IsString(),
    _ts_metadata("design:type", String)
], GetErrorsQueryDto.prototype, "type", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Start date (ISO 8601)'
    }),
    IsOptional(),
    IsDateString(),
    _ts_metadata("design:type", String)
], GetErrorsQueryDto.prototype, "startDate", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'End date (ISO 8601)'
    }),
    IsOptional(),
    IsDateString(),
    _ts_metadata("design:type", String)
], GetErrorsQueryDto.prototype, "endDate", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Filter by user ID'
    }),
    IsOptional(),
    IsString(),
    _ts_metadata("design:type", String)
], GetErrorsQueryDto.prototype, "userId", void 0);
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
], ErrorContextDto.prototype, "output_format", void 0);
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
    _ts_metadata("design:type", Number)
], ErrorContextDto.prototype, "pool_size", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", Number)
], ErrorContextDto.prototype, "active_connections", void 0);
let ErrorItemDto = class ErrorItemDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], ErrorItemDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], ErrorItemDto.prototype, "type", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], ErrorItemDto.prototype, "code", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], ErrorItemDto.prototype, "message", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], ErrorItemDto.prototype, "userId", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], ErrorItemDto.prototype, "userEmail", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], ErrorItemDto.prototype, "jobId", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], ErrorItemDto.prototype, "timestamp", void 0);
_ts_decorate([
    ApiProperty({
        enum: [
            'error',
            'warning',
            'critical'
        ]
    }),
    _ts_metadata("design:type", String)
], ErrorItemDto.prototype, "severity", void 0);
_ts_decorate([
    ApiProperty({
        type: ErrorContextDto,
        required: false
    }),
    _ts_metadata("design:type", typeof ErrorContextDto === "undefined" ? Object : ErrorContextDto)
], ErrorItemDto.prototype, "context", void 0);
let ErrorsSummaryDto = class ErrorsSummaryDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], ErrorsSummaryDto.prototype, "total", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Object)
], ErrorsSummaryDto.prototype, "bySeverity", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Record === "undefined" ? Object : Record)
], ErrorsSummaryDto.prototype, "byType", void 0);
let PaginationDto = class PaginationDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PaginationDto.prototype, "page", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PaginationDto.prototype, "limit", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PaginationDto.prototype, "total", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PaginationDto.prototype, "totalPages", void 0);
let ErrorsDataDto = class ErrorsDataDto {
};
_ts_decorate([
    ApiProperty({
        type: [
            ErrorItemDto
        ]
    }),
    _ts_metadata("design:type", Array)
], ErrorsDataDto.prototype, "errors", void 0);
_ts_decorate([
    ApiProperty({
        type: ErrorsSummaryDto
    }),
    _ts_metadata("design:type", typeof ErrorsSummaryDto === "undefined" ? Object : ErrorsSummaryDto)
], ErrorsDataDto.prototype, "summary", void 0);
_ts_decorate([
    ApiProperty({
        type: PaginationDto
    }),
    _ts_metadata("design:type", typeof PaginationDto === "undefined" ? Object : PaginationDto)
], ErrorsDataDto.prototype, "pagination", void 0);
export class AdminErrorsResponseDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], AdminErrorsResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        type: ErrorsDataDto
    }),
    _ts_metadata("design:type", typeof ErrorsDataDto === "undefined" ? Object : ErrorsDataDto)
], AdminErrorsResponseDto.prototype, "data", void 0);

//# sourceMappingURL=admin-errors.dto.js.map