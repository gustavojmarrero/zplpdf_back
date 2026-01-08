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
import { FirestoreService } from "../../cache/firestore.service.js";
export class ValidationMetricsService {
    /**
   * Registra una validacion y sus resultados
   */ async recordValidation(data) {
        try {
            // Agrupar errores por codigo
            const errorCounts = this.countByCodes(data.errors);
            const warningCounts = this.countByCodes(data.warnings);
            // Log estructurado para analisis
            this.logger.log({
                event: 'zpl_validation',
                duration_ms: data.duration,
                block_count: data.blockCount,
                error_count: data.errors.length,
                warning_count: data.warnings.length,
                error_types: errorCounts,
                warning_types: warningCounts
            });
            // Guardar metricas agregadas en Firestore
            await this.saveAggregatedMetrics(data.duration, data.blockCount, errorCounts, warningCounts);
        } catch (error) {
            this.logger.error(`Error registrando metricas: ${error.message}`);
        }
    }
    /**
   * Cuenta ocurrencias por codigo de error/warning
   */ countByCodes(issues) {
        return issues.reduce((acc, issue)=>{
            acc[issue.code] = (acc[issue.code] || 0) + 1;
            return acc;
        }, {});
    }
    /**
   * Guarda metricas agregadas diarias en Firestore
   */ async saveAggregatedMetrics(duration, blockCount, errorCounts, warningCounts) {
        const today = new Date().toISOString().split('T')[0];
        const docId = `metrics_${today}`;
        try {
            const db = this.firestoreService.getDb();
            const docRef = db.collection(this.COLLECTION_NAME).doc(docId);
            const doc = await docRef.get();
            if (doc.exists) {
                // Actualizar metricas existentes
                const existing = doc.data();
                // Merge error counts
                const mergedErrors = {
                    ...existing.errorCounts
                };
                for (const [code, count] of Object.entries(errorCounts)){
                    mergedErrors[code] = (mergedErrors[code] || 0) + count;
                }
                // Merge warning counts
                const mergedWarnings = {
                    ...existing.warningCounts
                };
                for (const [code, count] of Object.entries(warningCounts)){
                    mergedWarnings[code] = (mergedWarnings[code] || 0) + count;
                }
                // Calcular promedio de duracion
                const newTotalValidations = existing.totalValidations + 1;
                const newAvgDuration = Math.round((existing.avgDurationMs * existing.totalValidations + duration) / newTotalValidations);
                await docRef.update({
                    totalValidations: newTotalValidations,
                    totalBlocks: existing.totalBlocks + blockCount,
                    errorCounts: mergedErrors,
                    warningCounts: mergedWarnings,
                    avgDurationMs: newAvgDuration,
                    updatedAt: new Date()
                });
            } else {
                // Crear nuevo documento de metricas
                const metrics = {
                    date: today,
                    totalValidations: 1,
                    totalBlocks: blockCount,
                    errorCounts,
                    warningCounts,
                    avgDurationMs: duration,
                    updatedAt: new Date()
                };
                await docRef.set(metrics);
            }
        } catch (error) {
            this.logger.error(`Error guardando metricas en Firestore: ${error.message}`);
        }
    }
    /**
   * Obtiene tendencias de errores de los ultimos N dias
   */ async getErrorTrends(days = 30) {
        try {
            const db = this.firestoreService.getDb();
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
            const startDateStr = startDate.toISOString().split('T')[0];
            const snapshot = await db.collection(this.COLLECTION_NAME).where('date', '>=', startDateStr).orderBy('date', 'desc').get();
            const aggregatedErrors = {};
            const errorsByDay = [];
            snapshot.forEach((doc)=>{
                const data = doc.data();
                // Agregar errores por dia
                const dayErrorCount = Object.values(data.errorCounts).reduce((sum, count)=>sum + count, 0);
                errorsByDay.push({
                    date: data.date,
                    count: dayErrorCount
                });
                // Agregar al total
                for (const [code, count] of Object.entries(data.errorCounts)){
                    aggregatedErrors[code] = (aggregatedErrors[code] || 0) + count;
                }
            });
            // Ordenar errores por frecuencia
            const mostCommonErrors = Object.entries(aggregatedErrors).map(([code, count])=>({
                    code,
                    count,
                    description: this.getErrorDescription(code)
                })).sort((a, b)=>b.count - a.count).slice(0, 10);
            return {
                mostCommonErrors,
                errorsByDay: errorsByDay.sort((a, b)=>new Date(a.date).getTime() - new Date(b.date).getTime())
            };
        } catch (error) {
            this.logger.error(`Error obteniendo tendencias: ${error.message}`);
            return {
                mostCommonErrors: [],
                errorsByDay: []
            };
        }
    }
    /**
   * Obtiene descripcion de un codigo de error
   */ getErrorDescription(code) {
        const descriptions = {
            ZPL_STRUCT_000: 'No se encontraron etiquetas completas',
            ZPL_STRUCT_001: 'Falta ^XA',
            ZPL_STRUCT_002: 'Falta ^XZ',
            ZPL_STRUCT_003: 'Multiples ^XA',
            ZPL_STRUCT_004: 'Multiples ^XZ',
            ZPL_FIELD_001: 'Desequilibrio ^FD/^FS',
            ZPL_FIELD_002: 'Campo vacio',
            ZPL_FIELD_003: '^FD sin posicion',
            ZPL_POS_001: '^FO sin coordenadas',
            ZPL_POS_002: 'Coordenadas negativas',
            ZPL_POS_003: 'Coordenadas muy grandes',
            ZPL_POS_004: '^FT sin coordenadas',
            ZPL_BC_001: 'Codigo de barras no soportado',
            ZPL_BC_002: 'Orientacion invalida',
            ZPL_BC_003: 'Modelo QR invalido',
            ZPL_BC_004: 'Ancho de barra invalido',
            ZPL_BC_005: 'Codigo de barras sin datos',
            ZPL_CMD_001: 'Comando no soportado',
            ZPL_CMD_002: 'Comando deprecado',
            ZPL_CMD_003: 'Caja grafica invalida',
            ZPL_CMD_004: 'Fuente desconocida'
        };
        return descriptions[code] || code;
    }
    constructor(firestoreService){
        this.firestoreService = firestoreService;
        this.logger = new Logger(ValidationMetricsService.name);
        this.COLLECTION_NAME = 'validation_metrics';
    }
}
ValidationMetricsService = _ts_decorate([
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof FirestoreService === "undefined" ? Object : FirestoreService
    ])
], ValidationMetricsService);

//# sourceMappingURL=validation-metrics.service.js.map