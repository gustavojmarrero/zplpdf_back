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
import { IsString, IsEmail, IsNumber, Min, IsOptional } from "class-validator";
export class EnterpriseContactDto {
}
_ts_decorate([
    ApiProperty({
        description: 'Company name'
    }),
    IsString(),
    _ts_metadata("design:type", String)
], EnterpriseContactDto.prototype, "companyName", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Contact person name'
    }),
    IsString(),
    _ts_metadata("design:type", String)
], EnterpriseContactDto.prototype, "contactName", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Contact email'
    }),
    IsEmail(),
    _ts_metadata("design:type", String)
], EnterpriseContactDto.prototype, "email", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Phone number',
        required: false
    }),
    IsString(),
    IsOptional(),
    _ts_metadata("design:type", String)
], EnterpriseContactDto.prototype, "phone", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Estimated labels per month',
        minimum: 1
    }),
    IsNumber(),
    Min(1),
    _ts_metadata("design:type", Number)
], EnterpriseContactDto.prototype, "estimatedLabelsPerMonth", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Additional message',
        required: false
    }),
    IsString(),
    IsOptional(),
    _ts_metadata("design:type", String)
], EnterpriseContactDto.prototype, "message", void 0);
export class EnterpriseContactResponseDto {
}
_ts_decorate([
    ApiProperty({
        description: 'Success status'
    }),
    _ts_metadata("design:type", Boolean)
], EnterpriseContactResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Response message'
    }),
    _ts_metadata("design:type", String)
], EnterpriseContactResponseDto.prototype, "message", void 0);

//# sourceMappingURL=enterprise-contact.dto.js.map