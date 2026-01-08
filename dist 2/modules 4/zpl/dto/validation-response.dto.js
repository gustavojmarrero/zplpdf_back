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
export class ValidationIssueDto {
}
_ts_decorate([
    ApiProperty({
        example: 'ZPL_FIELD_001'
    }),
    _ts_metadata("design:type", String)
], ValidationIssueDto.prototype, "code", void 0);
_ts_decorate([
    ApiProperty({
        example: 'field'
    }),
    _ts_metadata("design:type", String)
], ValidationIssueDto.prototype, "type", void 0);
_ts_decorate([
    ApiProperty({
        example: 'error'
    }),
    _ts_metadata("design:type", String)
], ValidationIssueDto.prototype, "severity", void 0);
_ts_decorate([
    ApiProperty({
        example: 'Desequilibrio de campos: 3 ^FD encontrados pero 2 ^FS'
    }),
    _ts_metadata("design:type", String)
], ValidationIssueDto.prototype, "message", void 0);
_ts_decorate([
    ApiProperty({
        example: 1,
        required: false
    }),
    _ts_metadata("design:type", Number)
], ValidationIssueDto.prototype, "line", void 0);
_ts_decorate([
    ApiProperty({
        example: 45,
        required: false
    }),
    _ts_metadata("design:type", Number)
], ValidationIssueDto.prototype, "position", void 0);
_ts_decorate([
    ApiProperty({
        example: '...^FO50,50^FD...',
        required: false
    }),
    _ts_metadata("design:type", String)
], ValidationIssueDto.prototype, "context", void 0);
_ts_decorate([
    ApiProperty({
        example: 'Verifique que cada ^FD tenga su correspondiente ^FS',
        required: false
    }),
    _ts_metadata("design:type", String)
], ValidationIssueDto.prototype, "suggestion", void 0);
_ts_decorate([
    ApiProperty({
        example: '^FD',
        required: false
    }),
    _ts_metadata("design:type", String)
], ValidationIssueDto.prototype, "command", void 0);
export class ValidationSummaryDto {
}
_ts_decorate([
    ApiProperty({
        example: 3
    }),
    _ts_metadata("design:type", Number)
], ValidationSummaryDto.prototype, "totalBlocks", void 0);
_ts_decorate([
    ApiProperty({
        example: 2
    }),
    _ts_metadata("design:type", Number)
], ValidationSummaryDto.prototype, "validBlocks", void 0);
_ts_decorate([
    ApiProperty({
        example: 1
    }),
    _ts_metadata("design:type", Number)
], ValidationSummaryDto.prototype, "errorCount", void 0);
_ts_decorate([
    ApiProperty({
        example: 2
    }),
    _ts_metadata("design:type", Number)
], ValidationSummaryDto.prototype, "warningCount", void 0);
_ts_decorate([
    ApiProperty({
        example: 0
    }),
    _ts_metadata("design:type", Number)
], ValidationSummaryDto.prototype, "infoCount", void 0);
_ts_decorate([
    ApiProperty({
        example: {
            structure: true,
            field: false,
            position: true,
            barcode: true,
            command: true
        }
    }),
    _ts_metadata("design:type", typeof Record === "undefined" ? Object : Record)
], ValidationSummaryDto.prototype, "validatorResults", void 0);
export class ValidationDataDto {
}
_ts_decorate([
    ApiProperty({
        example: false
    }),
    _ts_metadata("design:type", Boolean)
], ValidationDataDto.prototype, "isValid", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            ValidationIssueDto
        ]
    }),
    _ts_metadata("design:type", Array)
], ValidationDataDto.prototype, "errors", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            ValidationIssueDto
        ]
    }),
    _ts_metadata("design:type", Array)
], ValidationDataDto.prototype, "warnings", void 0);
_ts_decorate([
    ApiProperty({
        type: ValidationSummaryDto
    }),
    _ts_metadata("design:type", typeof ValidationSummaryDto === "undefined" ? Object : ValidationSummaryDto)
], ValidationDataDto.prototype, "summary", void 0);
export class ValidationResponseDto {
}
_ts_decorate([
    ApiProperty({
        example: true
    }),
    _ts_metadata("design:type", Boolean)
], ValidationResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        example: 'Se encontraron problemas en el ZPL'
    }),
    _ts_metadata("design:type", String)
], ValidationResponseDto.prototype, "message", void 0);
_ts_decorate([
    ApiProperty({
        type: ValidationDataDto
    }),
    _ts_metadata("design:type", typeof ValidationDataDto === "undefined" ? Object : ValidationDataDto)
], ValidationResponseDto.prototype, "data", void 0);

//# sourceMappingURL=validation-response.dto.js.map