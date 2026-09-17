# Planes y tour · revisión del18septiembre2026

Implementación coordinada por Orca entre backend y frontend, con BE11 desarrollado por Claude y revisado por el coordinador. Frontend conserva infraestructura y ambos despliegues. Referencia frontend: issue309, PR308 y `docs/growth/fe08-reference-lock.md` en zplpdf_front; guía Refero aplicada al recorrido existente BillingTour.

## Cambios verificados

- Matriz comercial impuesta en servidor, con 41 casos de permisos, flags, controles, bajada de plan y piloto nominal. No cambia precios, cuotas ni suscripciones.
- Manifiesto `PRODUCT_UPDATES_RELEASE` singular, cerrado por entorno/fecha/aprobación y filtrado por acceso. Los siete routeKeys acordados son workflows/templates/pdf/integrations/printing/regression/api.
- Progreso privado por cuenta/release/versión: documento con hash, CAS, eventId y huella del contenido, supresión persistente después de completar u omitir, repetición explícita y limpieza al borrar cuenta.
- Eventos del tour solo con consentimiento; nunca cuentan como éxito funcional ni siembran solicitudes de feedback por uso exitoso. El snapshot agrega actividad del tour con cobertura de eventos independiente de Stripe y sin identificadores de usuarios.
- Workflow diario/por PR con pruebas unitarias y emulador del tour. A08/A09 consumen el contrato ampliado del COE desde `coe-prompts.md`.

## Evidencia backend

- Suite completa: **1471 pruebas, 76 suites**, sin fallos, antes del último endurecimiento del parser de fecha. Archivo privado `.local/growth/plans-tour-full-tests.json`.
- Después del ajuste de fecha: **76 pruebas** de product-updates y product-observability, sin fallos; typecheck nuevamente correcto. Un caso nuevo de normalización de fecha se añadió al módulo.
- Lint global y build correctos; build compiló368 archivos. Compilación y lint del módulo repetidos sobre el parser final, sin errores.
- Cinco pruebas reales en Firestore verifican dos escritores concurrentes, reintento desde otra conexión, rechazo de eventId reutilizado con otro cuerpo, supresión tras replay, aislamiento y lápida de borrado. Detalle en `product-updates-review.md`.
- Tres pruebas Node verifican integridad, dependencia y exportación privada de artefactos COE.

## Revisión frontend

70 pruebas unitarias y typecheck reportados por su responsable. Matriz visual de cuatro idiomas por dos anchos con cinco planes, teclado, conflicto, release desactivado y consentimiento rechazado, completada en dev y start; resultados en `Documents/ZPLPDF/frontend/evidence/fe08-2026-09-18-dev/product-updates-results.json` y el directorio equivalente `fe08-2026-09-18-start`.

El coordinador inspeccionó capturas de móvil/escritorio en inglés, español y chino. Se corrigieron dos hallazgos: una respuesta tardía de otra cuenta podía afectar el estado del guardado, y faltaba fondo al tour cuando no encontraba el elemento que señalar. El hook ahora mantiene un propietario por encarnación de cuenta; la prueba cubre dos PATCH simultáneos de cuentas diferentes. Captura corregida sin elemento disponible revisada en `fe08-overlay-fix/zh-390-tour-missing-anchor-fixed.png`.

## Publicación

Los ejemplos de flags y manifiesto permanecen desactivados. Los recibos de infraestructura y la imagen anterior no demuestran que BE11/FE08 estén desplegados. El operador debe publicar el SHA nuevo y certificar únicamente las funciones verificadas en el entorno; OAuth Drive e impresión física requieren su propia evidencia. Esta entrega no declara cerrados los43puntos originales ni afirma crecimiento de suscriptores.
