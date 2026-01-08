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
import { IsString, IsNotEmpty, IsOptional, IsEnum } from "class-validator";
import { LabelSize } from "../enums/label-size.enum.js";
import { OutputFormat } from "../enums/output-format.enum.js";
export class ConvertZplDto {
}
_ts_decorate([
    ApiProperty({
        description: 'Contenido ZPL a convertir a PDF (opcional si se envía archivo)',
        example: '^XA^FO50,50^A0N,50,50^FDHello World^FS^XZ',
        required: false
    }),
    IsString(),
    IsOptional(),
    _ts_metadata("design:type", String)
], ConvertZplDto.prototype, "zplContent", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Tamaño de la etiqueta (2x1, 2x4, 4x2 o 4x6 pulgadas)',
        example: LabelSize.TWO_BY_ONE,
        enum: LabelSize,
        default: LabelSize.TWO_BY_ONE
    }),
    IsEnum(LabelSize),
    IsNotEmpty(),
    _ts_metadata("design:type", typeof LabelSize === "undefined" ? Object : LabelSize)
], ConvertZplDto.prototype, "labelSize", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Idioma para los mensajes',
        example: 'es',
        default: 'es'
    }),
    IsString(),
    IsOptional(),
    _ts_metadata("design:type", String)
], ConvertZplDto.prototype, "language", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Formato de salida (pdf, png, jpeg). PNG y JPEG solo disponibles para usuarios Pro y Enterprise',
        example: OutputFormat.PDF,
        enum: OutputFormat,
        default: OutputFormat.PDF,
        required: false
    }),
    IsEnum(OutputFormat),
    IsOptional(),
    _ts_metadata("design:type", typeof OutputFormat === "undefined" ? Object : OutputFormat)
], ConvertZplDto.prototype, "outputFormat", void 0);

//# sourceMappingURL=convert-zpl.dto.js.map