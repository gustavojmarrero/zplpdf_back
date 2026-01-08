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
import { IsString, IsOptional, IsBoolean, IsIn } from "class-validator";
export class ValidateZplDto {
}
_ts_decorate([
    ApiProperty({
        description: 'Contenido ZPL a validar (opcional si se envia archivo)',
        example: '^XA^FO50,50^A0N,50,50^FDHello World^FS^XZ',
        required: false
    }),
    IsString(),
    IsOptional(),
    _ts_metadata("design:type", String)
], ValidateZplDto.prototype, "zplContent", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Idioma para mensajes de error (es/en)',
        example: 'es',
        default: 'es',
        enum: [
            'es',
            'en'
        ]
    }),
    IsIn([
        'es',
        'en'
    ]),
    IsOptional(),
    _ts_metadata("design:type", String)
], ValidateZplDto.prototype, "language", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Modo estricto: warnings se tratan como errores',
        example: false,
        default: false
    }),
    IsBoolean(),
    IsOptional(),
    _ts_metadata("design:type", Boolean)
], ValidateZplDto.prototype, "strictMode", void 0);

//# sourceMappingURL=validate-zpl.dto.js.map