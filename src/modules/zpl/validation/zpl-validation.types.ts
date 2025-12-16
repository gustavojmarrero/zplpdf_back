/**
 * Tipos e interfaces para el sistema de validacion ZPL
 */

// Severidad del problema detectado
export type ValidationSeverity = 'error' | 'warning' | 'info';

// Tipo de validador que detecta el problema
export type ValidatorType =
  | 'structure'
  | 'field'
  | 'position'
  | 'barcode'
  | 'command';

// Problema de validacion individual
export interface ValidationIssue {
  code: string; // Codigo unico: 'ZPL_STRUCT_001'
  type: ValidatorType; // Tipo de validador que lo detecto
  severity: ValidationSeverity;
  message: string; // Mensaje en idioma seleccionado
  line?: number; // Linea aproximada del error
  position?: number; // Posicion en el string
  context?: string; // Fragmento de ZPL donde ocurre
  suggestion?: string; // Sugerencia de correccion
  command?: string; // Comando ZPL relacionado (^FO, ^BC, etc)
}

// Resumen de validacion
export interface ValidationSummary {
  totalBlocks: number; // Total de bloques ^XA...^XZ
  validBlocks: number; // Bloques sin errores
  errorCount: number;
  warningCount: number;
  infoCount: number;
  validatorResults: Record<ValidatorType, boolean>;
}

// Resultado completo de validacion
export interface ValidationResult {
  isValid: boolean; // true si no hay errores (warnings OK)
  errors: ValidationIssue[]; // Problemas criticos
  warnings: ValidationIssue[]; // Advertencias no bloqueantes
  info: ValidationIssue[]; // Informacion adicional
  summary: ValidationSummary;
  processedAt: Date;
}

// Opciones de validacion
export interface ValidationOptions {
  language: 'es' | 'en';
  strictMode?: boolean; // Tratar warnings como errors
  skipValidators?: ValidatorType[];
  maxErrorsPerBlock?: number; // Limitar errores por bloque
}

// Interface base para validadores
export interface IZplValidator {
  type: ValidatorType;
  validate(block: string, options: ValidationOptions): ValidationIssue[];
}

// Metricas de validacion para Firestore
export interface ValidationMetrics {
  date: string; // YYYY-MM-DD
  totalValidations: number;
  totalBlocks: number;
  errorCounts: Record<string, number>; // Conteo por codigo de error
  warningCounts: Record<string, number>; // Conteo por codigo de warning
  avgDurationMs: number;
  updatedAt: Date;
}
