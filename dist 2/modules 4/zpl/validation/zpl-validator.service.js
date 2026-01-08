function _ts_decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for(var i = decorators.length - 1; i >= 0; i--)if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function _ts_metadata(k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
import { Injectable, Logger } from "@nestjs/common";
import { StructureValidator } from "./validators/structure-validator.js";
import { FieldValidator } from "./validators/field-validator.js";
import { PositionValidator } from "./validators/position-validator.js";
import { BarcodeValidator } from "./validators/barcode-validator.js";
import { CommandValidator } from "./validators/command-validator.js";
import { ValidationMetricsService } from "../logging/validation-metrics.service.js";
export class ZplValidatorService {
    /**
   * Valida contenido ZPL completo
   * @param zplContent Contenido ZPL a validar
   * @param options Opciones de validacion
   * @returns Resultado de validacion con errores, warnings e info
   */ async validate(zplContent, options = {
        language: 'es'
    }) {
        const startTime = Date.now();
        const allIssues = [];
        // 1. Extraer bloques ZPL
        const blocks = this.extractBlocks(zplContent);
        if (blocks.length === 0) {
            // Si no hay bloques, verificar si hay contenido ZPL parcial
            const hasPartialZpl = zplContent.includes('^XA') || zplContent.includes('^XZ');
            if (hasPartialZpl) {
                allIssues.push({
                    code: 'ZPL_STRUCT_000',
                    type: 'structure',
                    severity: 'error',
                    message: options.language === 'es' ? 'No se encontraron etiquetas ZPL completas (^XA...^XZ)' : 'No complete ZPL labels found (^XA...^XZ)',
                    suggestion: options.language === 'es' ? 'Verifique que cada etiqueta tenga ^XA al inicio y ^XZ al final' : 'Verify each label has ^XA at start and ^XZ at end'
                });
            }
        }
        // 2. Ejecutar cada validador en cada bloque
        for (const [blockIndex, block] of blocks.entries()){
            const blockIssues = this.validateBlock(block, blockIndex, options);
            allIssues.push(...blockIssues);
            // Limitar errores por bloque si se especifica
            if (options.maxErrorsPerBlock) {
                const blockErrors = blockIssues.filter((i)=>i.severity === 'error');
                if (blockErrors.length > options.maxErrorsPerBlock) {
                    break;
                }
            }
        }
        // 3. Clasificar y construir resultado
        const result = this.buildResult(allIssues, blocks.length, options);
        // 4. Registrar metricas
        const duration = Date.now() - startTime;
        this.metricsService.recordValidation({
            duration,
            blockCount: blocks.length,
            errors: result.errors,
            warnings: result.warnings
        }).catch((err)=>this.logger.error(`Error registrando metricas: ${err.message}`));
        this.logger.log(`Validacion completada: ${blocks.length} bloques, ${result.errors.length} errores, ${result.warnings.length} warnings (${duration}ms)`);
        return result;
    }
    /**
   * Valida un solo bloque ZPL
   */ validateBlock(block, blockIndex, options) {
        const issues = [];
        for (const validator of this.validators){
            // Saltar validadores si se especifica en opciones
            if (options.skipValidators?.includes(validator.type)) {
                continue;
            }
            try {
                const validatorIssues = validator.validate(block, options);
                // Agregar contexto del bloque a cada issue
                issues.push(...validatorIssues.map((issue)=>({
                        ...issue,
                        context: issue.context || this.getContext(block, issue.position),
                        line: this.getLineNumber(block, issue.position)
                    })));
            } catch (error) {
                this.logger.error(`Error en validador ${validator.type}: ${error.message}`);
            }
        }
        return issues;
    }
    /**
   * Extrae bloques ZPL del contenido (^XA...^XZ)
   */ extractBlocks(zpl) {
        const blocks = zpl.match(/\^XA[\s\S]*?\^XZ/g) || [];
        return blocks;
    }
    /**
   * Obtiene contexto alrededor de una posicion
   */ getContext(block, position) {
        if (position === undefined) return '';
        const start = Math.max(0, position - 15);
        const end = Math.min(block.length, position + 25);
        let context = block.slice(start, end);
        if (start > 0) context = '...' + context;
        if (end < block.length) context = context + '...';
        return context.replace(/[\r\n]+/g, ' ');
    }
    /**
   * Calcula el numero de linea aproximado
   */ getLineNumber(block, position) {
        if (position === undefined) return undefined;
        const beforePosition = block.substring(0, position);
        const lines = beforePosition.split(/\r?\n/);
        return lines.length;
    }
    /**
   * Construye el resultado final de validacion
   */ buildResult(issues, totalBlocks, options) {
        const errors = issues.filter((i)=>i.severity === 'error');
        const warnings = issues.filter((i)=>i.severity === 'warning');
        const info = issues.filter((i)=>i.severity === 'info');
        // En modo estricto, warnings tambien invalidan
        const isValid = options.strictMode ? errors.length === 0 && warnings.length === 0 : errors.length === 0;
        // Calcular bloques validos (sin errores)
        const blocksWithErrors = new Set(errors.map((e)=>e.line).filter((l)=>l !== undefined)).size;
        return {
            isValid,
            errors,
            warnings,
            info,
            summary: {
                totalBlocks,
                validBlocks: Math.max(0, totalBlocks - blocksWithErrors),
                errorCount: errors.length,
                warningCount: warnings.length,
                infoCount: info.length,
                validatorResults: this.getValidatorResults(issues)
            },
            processedAt: new Date()
        };
    }
    /**
   * Obtiene resultados por validador
   */ getValidatorResults(issues) {
        const types = [
            'structure',
            'field',
            'position',
            'barcode',
            'command'
        ];
        return types.reduce((acc, type)=>{
            const hasErrors = issues.some((i)=>i.type === type && i.severity === 'error');
            acc[type] = !hasErrors;
            return acc;
        }, {});
    }
    constructor(metricsService){
        this.metricsService = metricsService;
        this.logger = new Logger(ZplValidatorService.name);
        this.validators = [];
        // Registrar validadores en orden de ejecucion
        this.validators = [
            new StructureValidator(),
            new FieldValidator(),
            new PositionValidator(),
            new BarcodeValidator(),
            new CommandValidator()
        ];
    }
}
ZplValidatorService = _ts_decorate([
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof ValidationMetricsService === "undefined" ? Object : ValidationMetricsService
    ])
], ZplValidatorService);

//# sourceMappingURL=zpl-validator.service.js.map