# Acceso comercial aprobado · 2026-09-18

Usuario aprobó implementar esta matriz sin modificar precios, cuotas vigentes o prestaciones existentes.

| Plan | Nuevas funciones incluidas |
|---|---|
| free / lite | Ninguna; pueden descubrir novedades publicadas con CTA al plan correspondiente. |
| pro | packing_workflow, data_templates, pdf_preparation |
| promax | Todo Pro + folder_automation, direct_print, template_regression |
| enterprise | Todo Pro Max + self_service_api |

El servidor impone `feature-entitlements.ts`; allowedPlans de PRODUCT_FEATURE_FLAGS puede restringir pero nunca ampliar esta matriz. Una configuración con free/lite no concede acceso. Se reevalúa el plan en cada comprobación; la asignación histórica no conserva autorización después de una bajada de plan. Simulación admin sigue siendo sintética.

GET /api/users/me/features conserva schemaVersion1 y campos existentes; añade por feature:
- `minimumPlan`: pro | promax | enterprise, requisito comercial estable.
- `entitled`: pertenece al plan aunque la función todavía no esté habilitada.
- `eligible`: entitled y allowedPlans del flag.
- `available`: eligible, flag activo, sin kill switch y treatment de asignación persistida.
- `released`: flag activo, sin kill switch, rolloutPercent100 y TODOS los planes con entitlement incluidos en allowedPlans. Es una señal de oferta general, NO recibo de despliegue. PRODUCT_UPDATES_RELEASE debe certificar la publicación compatible antes de anunciarlo.

Un piloto no debe mostrar CTA que garantice acceso tras mejorar el plan. Si entitled=true y available=false mostrar indisponibilidad/estado de lanzamiento, no pedir pago adicional. Un usuario control sigue sin acceso aunque se aumente porcentaje; no se reasigna silenciosamente.

`approved-plan-flags.disabled.json` contiene matriz y configuración de referencia apagada. Activar exige la configuración del entorno y evidencia de la función, y no se ha realizado desde este cambio de código. No alterar suscripciones ni flags remotos al copiar documentación.

El usuario ahora autoriza construir FE08 y BE11; reemplaza la espera documental para implementación del tour. Sus pasos solo describen funciones publicadas y respetan permiso actual; avances del lanzamiento anterior se mantienen con evidencias propias.

## Piloto nominal

Cada flag admite `pilotAccountIds?: string[]` exclusivamente en servidor, con máximo15 IDs únicos (lista vacía no concede acceso a nadie). Solo seleccionados y con plan incluido pueden ser asignados; los demás no reciben asignación control anticipada. La lista nunca aparece en la respuesta API. Un piloto siempre tiene released=false y por ello no anuncia una oferta general. Quitar la lista conserva asignaciones previas; el plan nunca cambia automáticamente. Configurar IDs concretos y activar requiere selección real del piloto; no se enviaron invitaciones.

## Presentación del tour

`product-updates-release.disabled.json` es una plantilla DESACTIVADA, no una evidencia de publicación. El operador debe fijar entorno/fecha real y enumerar únicamente funciones cuya publicación comprobó. Los usuarios registrados antes de esa fecha pueden recibir invitación en línea si hay pasos incluidos o información de upgrades realmente liberados. No abrir un modal automáticamente.

## Analítica del tour

Mismo endpoint/consentimiento de FE00, con eventName tour_invitation_viewed, tour_started, tour_step_viewed, tour_dismissed, tour_completed, tour_feature_opened o tour_upgrade_clicked. surface=tour; releaseId/tourVersion obligatorios, tourStepId opcional salvo step_viewed; sin action. Servidor valida contra release aprobado y permisos vigentes. No son éxitos de negocio ni disparan encuestas por uso exitoso. Progreso operativo persiste aun rechazando analítica.

Snapshot schema2 añade `tour` con población observada consentida, window, status/coverage y por release/version cuentas invitadas, iniciadas, completadas, cerradas, apertura de función y clic de upgrade; tasa completada solo entre inicios observados y con cobertura completa. No publica IDs de usuarios, ni convierte un clic en pago, ni exige que una cohorte comercial haya madurado para mostrar datos operativos de QA.
