# Evidencia de implementación — 17 septiembre 2026

Actualización18septiembre: el usuario autorizó la matriz comercial y la construcción de BE11/FE08. Ambos están en revisión, con contrato en `product-updates-contract.md` y `plan-entitlements-contract.md`. El bloque siguiente conserva la evidencia histórica del programa; los estados operativos y números de pruebas anteriores no describen la revisión nueva.

Backend `gustavojmarrero/growth-implementation`; frontend `gustavojmarrero/growth-frontend`.
Programa GitHub backend #123; frontend #306, #307 y tour #305. Sin despliegue ni flags habilitados.

## Evidencia local

A las 21:34 UTC pasaron **1.384 pruebas en 70 suites** del backend completo, con las correcciones de revisión de PDF, API, Drive y retención. Typecheck y lint global sin errores. Siete pruebas reales de Firestore verifican concurrencia de cuota, rollback, deduplicación, propietarios, presets y fencing de workflows/plantillas. Nueve pruebas financieras reales verifican publicación con dos clientes, pagos/reembolsos y aislamiento live/test. Doce pruebas reales de retención verifican limpieza concurrente, revalidación entre consulta y transacción, privacidad y conservación de cuota/evidencia. Las siete de dominio se repitieron después del aislamiento PDF; las doce de retención después de reforzar la carrera. Tres pruebas Node verifican COE y exportación privada con checksum, rechazo de PII y redirecciones.

## Desarrollo

- BE00/01: eventos, consentimiento, flags, asignaciones estables, outbox y borrado de cuenta integrados. Señales operativas de errores/cuotas con cobertura best_effort explícita.
- BE02/03: ledger Stripe, primer pago histórico, conciliación readonly paginada, inventario neto, cohortes, renovaciones, costes y contratos enterprise. Snapshot v2 sin identificadores ni etiquetas libres de fuentes. 88 pruebas unitarias financieras al último reporte, además de las nueve de emulador.
- BE04/05: lotes, selección y orden, previsualizaciones privadas, plantillas versionadas, CSV/Excel y exportaciones durables; reservas con fencing y outbox atómico. 224 pruebas del dominio y dos casos de concurrencia real incluidos en las siete de Firestore.
- BE06/A14: API keys, cola, cuota, callbacks firmados, protección SSRF y panel Firebase. Prueba gratuita de autenticación/esquema y conversión sintética opcional con cuota normal. Revisión independiente cerrada, incluidos cancelación/reintento/finalización frente a borrado de cuenta.
- BE07: preparación PDF, dimensiones físicas, recortes, rotaciones y presets persistentes versionados con CAS. QA visual local y prueba de cuota/historial/evento. Parser aislado por worker, tiempo y heap acotados; dist/ESM y geometría probados. El heap limitado no garantiza una cota RSS/nativa.
- BE08/09/A13/A15: Drive con recetas ZPL/PDF/plantilla congeladas y estado pausa/reanudar; revocación durable. PrintNode con estado indeterminado protegido, reimpresión explícita y confirmación física manual. Proveedores reales e impresoras no verificados.
- BE10: diez fixtures, baseline/run inmutables, diff visual y contenido, aprobación CAS, recuperación por lease. 40 pruebas locales; sin afirmar una versión del renderer externo no observada.
- FE00: commit local 3616a75; instrumentación y consentimiento con pruebas y Chrome multidioma.
- FE01–07: siete espacios de trabajo implementados por el agente frontend, commits f55465f/f1071c1/fe556a5. Panel de incidencias y finanzas v2. 49 pruebas unitarias al último informe; 64 pantallas Chrome en cuatro idiomas/móvil/escritorio pasaron tanto desarrollo como start; ampliación de fixtures visibles e informe final en curso.
- FA01–09: scripts QA/COE y workflows implementados; FA02–08 registrados desactivados. Reporte final del agente y revisión pendientes.

## Automatizaciones y operación

- A01–06: jobs OIDC, ventanas estables, backfill, calidad, agregación, panel y feedback in-app con cadencia global transaccional.
- A07: GitHub QA por PR/diaria/manual, corpus sintético y dos suites reales de Firestore. Falta corrida remota y staging.
- A08–11: cuatro jobs Orca DESACTIVADOS, exportador privado, precheck de integridad/frescura, dependencia A09/A08 y recibos. A10 corregido a día5 10:00 America/Merida conforme al plan. Sin datos observados los informes no inventan resultados.
- A12: TTL declarado solo sobre datos seguros; limpieza explícita por estado y backlog protegido implementados, con 28 pruebas unitarias y 12 reales. No eliminar reservas/contadores o outboxes pendientes a ciegas.
- Operación: admin permite listar y reencolar incidencias de eventos/callbacks/revocación. Tres pruebas de servicio y guards HTTP integrados pasan. Reencolar no significa entrega exitosa.
- Infraestructura: 17 jobs Scheduler inicialmente pausados; índices y TTL declarados en `infra/growth`. Terraform validado sin errores/advertencias, provider lock Google6.50.0; no aplicado a ningún proyecto.

## Puerta de lanzamiento y tour

La antigua espera de construcción de BE11/FE08 fue reemplazada por autorización explícita del usuario. El tour se implementa con manifiesto de publicación y permisos actuales; solo anuncia el subconjunto verificado en el entorno. El registro maestro en Documents/ZPLPDF distingue implementación de verificación de lanzamiento. Ninguna prueba local certifica pagos reales, OAuth, IAM, impresión física o crecimiento de suscriptores.
