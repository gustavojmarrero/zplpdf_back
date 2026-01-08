import { getMessages } from "../messages/error-messages.js";
/**
 * Validador de estructura ZPL
 * Verifica: ^XA/^XZ presentes, multiples ^XA/^XZ en un bloque
 */ export class StructureValidator {
    validate(block, options) {
        const issues = [];
        const messages = getMessages(options.language);
        const trimmedBlock = block.trim();
        // Verificar ^XA al inicio
        if (!trimmedBlock.startsWith('^XA')) {
            issues.push({
                code: 'ZPL_STRUCT_001',
                type: this.type,
                severity: 'error',
                message: messages.missingXA,
                position: 0,
                suggestion: messages.suggestXA,
                command: '^XA'
            });
        }
        // Verificar ^XZ al final
        if (!trimmedBlock.endsWith('^XZ')) {
            issues.push({
                code: 'ZPL_STRUCT_002',
                type: this.type,
                severity: 'error',
                message: messages.missingXZ,
                position: block.length,
                suggestion: messages.suggestXZ,
                command: '^XZ'
            });
        }
        // Verificar multiples ^XA dentro del bloque
        const xaMatches = block.match(/\^XA/g) || [];
        if (xaMatches.length > 1) {
            issues.push({
                code: 'ZPL_STRUCT_003',
                type: this.type,
                severity: 'error',
                message: messages.multipleXA,
                suggestion: messages.suggestSplitBlocks,
                command: '^XA'
            });
        }
        // Verificar multiples ^XZ dentro del bloque
        const xzMatches = block.match(/\^XZ/g) || [];
        if (xzMatches.length > 1) {
            issues.push({
                code: 'ZPL_STRUCT_004',
                type: this.type,
                severity: 'error',
                message: messages.multipleXZ,
                suggestion: messages.suggestSplitBlocks,
                command: '^XZ'
            });
        }
        return issues;
    }
    constructor(){
        this.type = 'structure';
    }
}

//# sourceMappingURL=structure-validator.js.map