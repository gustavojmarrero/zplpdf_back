import { ForbiddenException } from '@nestjs/common';

/**
 * Identificadores de funcionalidad del programa de crecimiento. Se repiten aquí
 * (en vez de importarlos de `product-observability`) para que estos módulos
 * compilen y se puedan probar sin depender del módulo de observabilidad, que se
 * integra por separado. Los valores son los mismos del contrato compartido.
 */
export type GrowthFeatureId =
  | 'packing_workflow'
  | 'data_templates'
  | 'self_service_api'
  | 'pdf_preparation'
  | 'folder_automation'
  | 'direct_print'
  | 'template_regression';

/**
 * Puerto de disponibilidad de funcionalidad. El adaptador real es
 * `FeatureFlagsService.assertFeatureAvailable` del módulo de observabilidad; lo
 * enlaza el coordinador.
 */
export interface FeatureGatePort {
  assertFeatureAvailable(
    accountId: string,
    featureId: GrowthFeatureId,
  ): Promise<void> | void;
}

export const FEATURE_GATE = Symbol('FEATURE_GATE');

/**
 * Comportamiento por defecto: **denegar**. El flag está apagado hasta que el
 * despliegue registre un adaptador, así que importar el módulo no abre la
 * función por accidente. Solo bloquea ingresos nuevos: leer o descargar lo ya
 * creado no pasa por aquí.
 */
export class DeniedByDefaultFeatureGate implements FeatureGatePort {
  assertFeatureAvailable(_accountId: string, featureId: GrowthFeatureId): void {
    throw new ForbiddenException({
      error: 'FEATURE_NOT_AVAILABLE',
      message: `La funcionalidad ${featureId} no está habilitada para esta cuenta`,
      data: { featureId, reason: 'no_feature_gate_configured' },
    });
  }
}
