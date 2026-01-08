import { getMessages } from "../messages/error-messages.js";
/**
 * Validador de codigos de barras ZPL
 * Verifica: Tipos soportados, orientacion, modelo QR, datos vacios
 */ export class BarcodeValidator {
    validate(block, options) {
        const issues = [];
        const messages = getMessages(options.language);
        // Buscar todos los comandos de codigo de barras
        const barcodePattern = /\^B([0-9A-Z])([^^\n]*)?/g;
        let match;
        while((match = barcodePattern.exec(block)) !== null){
            const command = '^B' + match[1];
            const params = match[2] || '';
            // Verificar si el tipo de codigo de barras es soportado
            if (!this.supportedBarcodes.includes(command)) {
                issues.push({
                    code: 'ZPL_BC_001',
                    type: this.type,
                    severity: 'error',
                    message: messages.unsupportedBarcode(command),
                    position: match.index,
                    context: match[0].substring(0, 30),
                    suggestion: messages.suggestSupportedBarcodes,
                    command
                });
                continue;
            }
            // Validaciones especificas por tipo
            switch(command){
                case '^BC':
                    this.validateCode128(params, match.index, issues, messages);
                    break;
                case '^BQ':
                    this.validateQRCode(params, match.index, issues, messages);
                    break;
                case '^BY':
                    this.validateBYDefault(params, match.index, issues, messages);
                    break;
            }
        }
        // Verificar que los codigos de barras tengan datos
        this.validateBarcodeData(block, issues, messages);
        return issues;
    }
    validateCode128(params, position, issues, messages) {
        // ^BCo,h,f,g,e,m - verificar orientacion valida
        const parts = params.split(',');
        const orientation = parts[0]?.trim();
        if (orientation && !this.validOrientations.includes(orientation)) {
            issues.push({
                code: 'ZPL_BC_002',
                type: this.type,
                severity: 'error',
                message: messages.invalidOrientation(orientation),
                position,
                suggestion: messages.suggestOrientations,
                command: '^BC'
            });
        }
    }
    validateQRCode(params, position, issues, messages) {
        // ^BQa,b,c - a=orientation, b=model, c=magnification
        const parts = params.split(',');
        // Verificar orientacion
        const orientation = parts[0]?.trim();
        if (orientation && !this.validOrientations.includes(orientation)) {
            issues.push({
                code: 'ZPL_BC_002',
                type: this.type,
                severity: 'error',
                message: messages.invalidOrientation(orientation),
                position,
                suggestion: messages.suggestOrientations,
                command: '^BQ'
            });
        }
        // Verificar modelo (debe ser 1 o 2)
        const model = parts[1]?.trim();
        if (model && ![
            '1',
            '2'
        ].includes(model)) {
            issues.push({
                code: 'ZPL_BC_003',
                type: this.type,
                severity: 'warning',
                message: messages.invalidQRModel,
                position,
                suggestion: messages.suggestQRModels,
                command: '^BQ'
            });
        }
    }
    validateBYDefault(params, position, issues, messages) {
        // ^BYw,r,h - w=module width, r=ratio, h=height
        const parts = params.split(',');
        const width = parts[0]?.trim();
        if (width) {
            const widthNum = parseInt(width, 10);
            if (!isNaN(widthNum) && (widthNum < 1 || widthNum > 10)) {
                issues.push({
                    code: 'ZPL_BC_004',
                    type: this.type,
                    severity: 'warning',
                    message: messages.invalidBarWidth,
                    position,
                    suggestion: messages.suggestBarWidth,
                    command: '^BY'
                });
            }
        }
    }
    validateBarcodeData(block, issues, messages) {
        // Buscar comandos de barcode seguidos de ^FD vacio
        // Patron: ^B[tipo][params]^FD^FS (sin datos entre ^FD y ^FS)
        const barcodeWithEmptyData = /\^B[0-9A-Z][^^\n]*\^FD\s*\^FS/g;
        let match;
        while((match = barcodeWithEmptyData.exec(block)) !== null){
            issues.push({
                code: 'ZPL_BC_005',
                type: this.type,
                severity: 'error',
                message: messages.emptyBarcodeData,
                position: match.index,
                context: match[0].substring(0, 40),
                suggestion: messages.suggestAddBarcodeData
            });
        }
    }
    constructor(){
        this.type = 'barcode';
        // Comandos de codigo de barras soportados por Labelary
        this.supportedBarcodes = [
            '^B1',
            '^B2',
            '^B3',
            '^B7',
            '^B8',
            '^B9',
            '^BA',
            '^BB',
            '^BC',
            '^BD',
            '^BE',
            '^BF',
            '^BI',
            '^BJ',
            '^BK',
            '^BL',
            '^BM',
            '^BO',
            '^BP',
            '^BQ',
            '^BR',
            '^BS',
            '^BU',
            '^BX',
            '^BY',
            '^BZ'
        ];
        // Orientaciones validas
        this.validOrientations = [
            'N',
            'R',
            'I',
            'B',
            ''
        ];
    }
}

//# sourceMappingURL=barcode-validator.js.map