import { getMessages } from "../messages/error-messages.js";
/**
 * Validador de posicionamiento ZPL
 * Verifica: ^FO/^FT con coordenadas validas, coordenadas negativas/grandes
 */ export class PositionValidator {
    validate(block, options) {
        const issues = [];
        const messages = getMessages(options.language);
        // Validar ^FO (Field Origin) - formato: ^FOx,y o ^FOx,y,z
        this.validateFO(block, issues, messages);
        // Validar ^FT (Field Typeset) - formato: ^FTx,y o ^FTx,y,z
        this.validateFT(block, issues, messages);
        return issues;
    }
    validateFO(block, issues, messages) {
        // Patron para capturar ^FO con o sin coordenadas
        const foPattern = /\^FO(-?\d+)?(?:,(-?\d+))?/g;
        let match;
        while((match = foPattern.exec(block)) !== null){
            const fullMatch = match[0];
            const x = match[1];
            const y = match[2];
            // Verificar que tiene coordenadas
            if (x === undefined || y === undefined) {
                issues.push({
                    code: 'ZPL_POS_001',
                    type: this.type,
                    severity: 'error',
                    message: messages.foMissingCoords,
                    position: match.index,
                    context: fullMatch,
                    suggestion: messages.suggestFoFormat,
                    command: '^FO'
                });
                continue;
            }
            const xNum = parseInt(x, 10);
            const yNum = parseInt(y, 10);
            // Verificar coordenadas negativas
            if (xNum < 0 || yNum < 0) {
                issues.push({
                    code: 'ZPL_POS_002',
                    type: this.type,
                    severity: 'warning',
                    message: messages.negativeCoords,
                    position: match.index,
                    context: fullMatch,
                    suggestion: messages.suggestPositiveCoords,
                    command: '^FO'
                });
            }
            // Verificar coordenadas excesivas
            if (xNum > this.MAX_COORD || yNum > this.MAX_COORD) {
                issues.push({
                    code: 'ZPL_POS_003',
                    type: this.type,
                    severity: 'warning',
                    message: messages.largeCoords,
                    position: match.index,
                    context: fullMatch,
                    suggestion: messages.suggestCheckLabelSize,
                    command: '^FO'
                });
            }
        }
    }
    validateFT(block, issues, messages) {
        // Patron para capturar ^FT con o sin coordenadas
        const ftPattern = /\^FT(\d+)?(?:,(\d+))?/g;
        let match;
        while((match = ftPattern.exec(block)) !== null){
            const fullMatch = match[0];
            const x = match[1];
            const y = match[2];
            // ^FT requiere coordenadas
            if (x === undefined || y === undefined) {
                issues.push({
                    code: 'ZPL_POS_004',
                    type: this.type,
                    severity: 'error',
                    message: messages.ftMissingCoords,
                    position: match.index,
                    context: fullMatch,
                    suggestion: messages.suggestFtFormat,
                    command: '^FT'
                });
                continue;
            }
            const xNum = parseInt(x, 10);
            const yNum = parseInt(y, 10);
            // Verificar coordenadas excesivas
            if (xNum > this.MAX_COORD || yNum > this.MAX_COORD) {
                issues.push({
                    code: 'ZPL_POS_003',
                    type: this.type,
                    severity: 'warning',
                    message: messages.largeCoords,
                    position: match.index,
                    context: fullMatch,
                    suggestion: messages.suggestCheckLabelSize,
                    command: '^FT'
                });
            }
        }
    }
    constructor(){
        this.type = 'position';
        // Limites razonables para coordenadas (en dots, 8dpmm = 203 dpi)
        this.MAX_COORD = 2000;
    }
}

//# sourceMappingURL=position-validator.js.map