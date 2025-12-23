import {
  IZplValidator,
  ValidatorType,
  ValidationIssue,
  ValidationOptions,
} from '../zpl-validation.types.js';
import { getMessages } from '../messages/error-messages.js';

/**
 * Validador de campos ZPL
 * Verifica: Balance ^FD/^FS, campos vacios, ^FD sin posicion previa
 */
export class FieldValidator implements IZplValidator {
  type: ValidatorType = 'field';

  validate(block: string, options: ValidationOptions): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const messages = getMessages(options.language);

    // NOTA: No validamos balance ^FD/^FS porque ^FS termina múltiples comandos
    // (^FX, ^GFA, ^GB, etc.), no solo ^FD. Es válido tener más ^FS que ^FD.

    // Verificar ^FD vacios (^FD seguido inmediatamente de ^FS)
    const emptyFdPattern = /\^FD\s*\^FS/g;
    let match;
    while ((match = emptyFdPattern.exec(block)) !== null) {
      issues.push({
        code: 'ZPL_FIELD_002',
        type: this.type,
        severity: 'warning',
        message: messages.emptyFd,
        position: match.index,
        context: match[0],
        suggestion: messages.suggestRemoveEmptyFd,
        command: '^FD',
      });
    }

    // Verificar ^FD sin ^FO/^FT previo
    const fdPositions = this.findAllPositions(block, /\^FD/g);
    const positionCommands = this.findAllPositions(block, /\^F[OT]/g);

    for (const fdPos of fdPositions) {
      // Buscar si hay un comando de posicion antes de este ^FD
      // y que no haya otro ^FD entre ellos
      const hasPriorPosition = positionCommands.some((pos) => {
        if (pos >= fdPos) return false;
        // Verificar que no hay otro ^FD entre el ^FO/^FT y este ^FD
        const betweenFds = fdPositions.filter((p) => p > pos && p < fdPos);
        return betweenFds.length === 0;
      });

      if (!hasPriorPosition && fdPos > 10) {
        // Ignorar si ^FD esta al inicio
        issues.push({
          code: 'ZPL_FIELD_003',
          type: this.type,
          severity: 'warning',
          message: messages.fdWithoutPosition,
          position: fdPos,
          suggestion: messages.suggestAddPosition,
          command: '^FD',
        });
      }
    }

    return issues;
  }

  private findAllPositions(str: string, regex: RegExp): number[] {
    const positions: number[] = [];
    let match;
    const re = new RegExp(regex.source, 'g');
    while ((match = re.exec(str)) !== null) {
      positions.push(match.index);
    }
    return positions;
  }
}
