import { getMessages } from "../messages/error-messages.js";
/**
 * Validador de comandos ZPL
 * Verifica: Comandos no soportados por Labelary, comandos deprecados
 */ export class CommandValidator {
    validate(block, options) {
        const issues = [];
        const messages = getMessages(options.language);
        // Extraer todos los comandos (empiezan con ^ o ~)
        const commandPattern = /[\^~]([A-Z][A-Z0-9]?)/g;
        let match;
        while((match = commandPattern.exec(block)) !== null){
            const command = '^' + match[1];
            // Verificar comandos no soportados
            if (this.unsupportedCommands.some((c)=>command.startsWith(c))) {
                issues.push({
                    code: 'ZPL_CMD_001',
                    type: this.type,
                    severity: 'warning',
                    message: messages.unsupportedCommand(command),
                    position: match.index,
                    suggestion: messages.suggestRemoveCommand(command),
                    command
                });
            }
            // Verificar comandos deprecados
            if (this.deprecatedCommands.some((c)=>command.startsWith(c))) {
                issues.push({
                    code: 'ZPL_CMD_002',
                    type: this.type,
                    severity: 'warning',
                    message: messages.deprecatedCommand(command),
                    position: match.index,
                    suggestion: messages.suggestAlternative(command),
                    command
                });
            }
        }
        // Verificar ^GB (Graphic Box) tiene parametros validos
        this.validateGraphicBox(block, issues, messages);
        // Verificar ^CF (Change Font) tiene fuente valida
        this.validateChangeFont(block, issues, messages);
        return issues;
    }
    validateGraphicBox(block, issues, messages) {
        // ^GBw,h,t,c,r - w=width, h=height, t=thickness, c=color, r=rounding
        const gbPattern = /\^GB(\d+)?,?(\d+)?/g;
        let match;
        while((match = gbPattern.exec(block)) !== null){
            const width = match[1] ? parseInt(match[1], 10) : 0;
            const height = match[2] ? parseInt(match[2], 10) : 0;
            // Ambas dimensiones en 0 es invalido
            if (width === 0 && height === 0) {
                issues.push({
                    code: 'ZPL_CMD_003',
                    type: this.type,
                    severity: 'error',
                    message: messages.invalidGraphicBox,
                    position: match.index,
                    context: match[0],
                    suggestion: messages.suggestGBParams,
                    command: '^GB'
                });
            }
        }
    }
    validateChangeFont(block, issues, messages) {
        // ^CFf,h,w - f=font, h=height, w=width
        const cfPattern = /\^CF([A-Z0-9])?/g;
        let match;
        while((match = cfPattern.exec(block)) !== null){
            const font = match[1];
            if (font && !this.validFonts.includes(font)) {
                issues.push({
                    code: 'ZPL_CMD_004',
                    type: this.type,
                    severity: 'warning',
                    message: messages.unknownFont(font),
                    position: match.index,
                    context: match[0],
                    suggestion: messages.suggestFonts,
                    command: '^CF'
                });
            }
        }
    }
    constructor(){
        this.type = 'command';
        // Comandos NO soportados o problematicos en Labelary
        this.unsupportedCommands = [
            '^JJ',
            '^JM',
            '^JU',
            '^MN',
            '^PR',
            '^PW',
            '^MD',
            '^MT',
            '^MM',
            '^MU',
            '^JZ',
            '^NC',
            '^NI',
            '^NN'
        ];
        // Comandos deprecados (warning)
        this.deprecatedCommands = [
            '^A@'
        ];
        // Fuentes validas en Labelary
        this.validFonts = [
            '0',
            'A',
            'B',
            'C',
            'D',
            'E',
            'F',
            'G',
            'H',
            'P',
            'Q',
            'R',
            'S',
            'T',
            'U',
            'V'
        ];
    }
}

//# sourceMappingURL=command-validator.js.map