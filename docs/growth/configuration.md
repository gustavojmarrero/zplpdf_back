# Configuración de las mejoras

Todos los flags quedan apagados por defecto. La aplicación mantiene el puerto8080. `.env.example` documenta nombres y valores vacíos; no contiene credenciales reales. No se ha cambiado ningún entorno remoto.

## Variables

| Variable | Uso |
|---|---|
| `PRODUCT_ENVIRONMENT` | Identidad de entorno de eventos, cohortes y ledger. `production` exige Stripe live; development/test usan Stripe test. No mezclar datasets. |
| `PRODUCT_FEATURE_FLAGS` | JSON de capacidades y experimentos; `{}` apaga las siete funcionalidades. Configuración inválida devuelve503. |
| `PUBLIC_API_ENCRYPTION_KEY` | Clave aleatoria de32bytes en base64 para cifrar credenciales API, OAuth y PrintNode. Conservar versión anterior durante una migración; cambiarla directamente impide descifrar conexiones existentes. |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REDIRECT_URI`, `GOOGLE_DRIVE_PICKER_APP_ID` | Aplicación OAuth/Picker del entorno; URI registrada exactamente. Requiere prueba de concesión y revocación antes del lanzamiento. |
| `GROWTH_STRIPE_READ_KEY` | Clave restringida dedicada, solo lectura de facturas/suscripciones/reembolsos. El prefijo test/live se valida en código; los permisos efectivos se deben comprobar en Stripe. No sustituir por la clave de cobros. |
| `GROWTH_COHORT_START` | FechaISO real desde la que se conoce la cobertura de exposición/asignación; no inventar histórico anterior. |
| `GROWTH_OPERATIONAL_SIGNALS_START` | FechaISO de inicio real de la instrumentación operativa; ausencia se publica como missing_data. |
| `GROWTH_EXCLUDED_ACCOUNT_IDS` | Exclusiones de QA/admin; alternativa persistente growth_excluded_accounts. Son datos privados de operación. |
| `GROWTH_RENEWAL_GRACE_DAYS` | Gracia para evaluar vencimientos maduros;7días por defecto. |
| `GROWTH_SCHEDULER_AUDIENCE` | Audiencia exacta del token OIDC y variable backend_url de Terraform. |
| `GROWTH_SCHEDULER_SERVICE_ACCOUNT` | Email exacto de la identidad invocadora; no admite cron compartido ni token de usuario. |

PrintNode recibe la clave de cada usuario a través del flujo privado de conexión; no hay una clave global del servicio. Los archivos usan el bucket y las credenciales de almacenamiento ya configuradas.

## Configuración de capacidades

Claves: `packing_workflow`, `data_templates`, `self_service_api`, `pdf_preparation`, `folder_automation`, `direct_print`, `template_regression`.

Ejemplo inactivo de estructura, sin cambiar decisiones de monetización:

```json
{"packing_workflow":{"enabled":false,"killSwitch":false,"owner":"product","updatedAt":"2026-09-17T00:00:00.000Z","version":"1","allowedPlans":[],"rolloutPercent":0,"experimentId":"packing-v1","assignmentVersion":"1"}}
```

Planes y porcentaje se acuerdan para el lanzamiento. La asignación queda estable por cuenta/experimento/versión: cambiar rolloutPercent no reasigna cuentas ya registradas. El kill switch y la elegibilidad se verifican en servidor. Las simulaciones de administradores y conversiones API testMode quedan fuera del uso comercial.

## Orden de activación

1. Confirmar proyectos Firestore/CloudRun, bucket, URLs backend/frontend, permisos y secretos del entorno. Los IDs históricos del repositorio difieren: no asumir que son intercambiables.
2. Revisar/combinar índices existentes con `infra/growth/firestore.indexes.json`; verificar ciclo de vida15d de objetos debug-zpl y TTL solo en colecciones seguras. No aplicar TTL a reservas activas ni outboxes no entregados.
3. Desplegar backend y frontend compatibles con flags apagados. Ejecutar corpus sintético, aislamiento de cuentas, cuotas concurrentes, pago test verificado, OAuth/revocación y prueba física de impresión.
4. Aplicar Scheduler pausado, invocar manualmente con OIDC y comprobar repetición/fallo/recuperación. Verificar cada próxima ejecución en America/Merida antes de habilitarlo.
5. Exportar snapshot agregado mediante `scripts/growth/export-snapshot.mjs` usando `GROWTH_BACKEND_URL` y un token admin efímero `GROWTH_ADMIN_TOKEN` en el proceso operador. No colocarlo en frontend ni en un prompt Orca. Verificar precheck/recibos antes de habilitar A08–A11.
6. Activar el alcance acordado y observar calidad antes de concluir adopción o conversión. Registrar recibos reales en el seguimiento maestro. El tour conserva la puerta de los43puntos verificados.

Terraform fue validado localmente; este orden describe acciones pendientes y no constituye un recibo de despliegue.
