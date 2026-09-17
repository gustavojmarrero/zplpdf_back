# Instrucciones propuestas para las automatizaciones COE de ZPLPDF

Estado: A08–A11 registrados en Orca y desactivados; recibos reales en orca-automation-receipts.json. COE significa provisionalmente ciclo de observación, evaluación y mejora continua.

## Contrato común

Trabaja únicamente sobre ZPLPDF y la ventana asignada a esta ejecución. Lee el plan de desarrollo vigente, el manifiesto de features y el manifiesto del snapshot. Usa hechos agregados producidos por el backend; no reconstruyas ingresos desde visitas o valores de GA4. No consultes ni imprimas secretos. No incluyas emails, direcciones, etiquetas reales, URLs firmadas o claves en informes.

El exportador `scripts/growth/export-snapshot.mjs` y los comandos `coe-precheck.mjs`/`coe-finish.mjs` están implementados. Si falta una dependencia, falla con `missing_dependency`, documenta qué falta y no inventes comandos ni datos. Si los datos llegan tarde o incompletos, informa `insufficient_data` con los campos ausentes. Distingue `not_deployed`, `no_eligible_accounts`, `zero_observed` y `missing_data`.

Cada corrida recibe `automationId`, `runId`, `periodStartUtc`, `periodEndUtc`, `timezone`, `snapshotManifestPath`, `snapshotPath`, `snapshotChecksum` y `outputDirectory`. Las salidas se guardan en un directorio único por corrida. Repetir la misma ventana y versión conserva la identidad de la revisión; no crea otra acción equivalente. Lee el archivo inmutable `snapshotPath` del precheck y verifica `snapshotChecksum`; el puntero actual puede avanzar durante una corrida. El cierre vuelve a verificar el checksum y A09 comprueba los artefactos del recibo A08. El snapshot contiene versión de consulta, denominadores, exclusiones, cobertura y frescura.

Se autoriza en el diseño de estas automatizaciones leer snapshots, analizar, escribir informes privados y preparar propuestas de tickets. Este prompt no ordena publicar issues, enviar mensajes, contactar usuarios, modificar suscripciones/precios, habilitar flags, imprimir documentos o desplegar. La ejecución de las propuestas será una tarea separada con alcance concreto. No deduzcas autorización para publicar del hecho de estar escribiendo un plan.

Las tareas Orca se crean desactivadas durante la implementación. Verificar zona horaria y próxima ejecución en el runtime antes de habilitar; el horario deseado es América/Mérida. El host local puede estar configurado en Europa/Roma. Nunca cambiar schedules por cuenta propia como parte del análisis.

## A08 — COE semanal · Codex

**Objetivo:** identificar hasta tres acciones que puedan mejorar activación, uso repetido, fiabilidad o nuevos pagos, con evidencia reproducible.

1. Valida integridad y frescura de los snapshots de uso, facturación, QA y feedback. Si falta uno, limita explícitamente las conclusiones afectadas; no conviertas una ausencia de medición en falta de uso.
2. Lista las features desplegadas y sus versiones. Para cada una, informa elegibles, expuestos, activados, repetidores W2, retenidos D30, pagos nuevos, reactivaciones y renovaciones maduras. Explica n/N y horizonte.
3. Separa cuentas existentes pagas, nuevas pagas, gratuitas, prueba y cortesía. Excluye actividad sintética y de administradores. No atribuyas a una feature todos los ingresos de cuentas que alguna vez la abrieron.
4. Contrasta cada indicador con el control asignado o la línea base comparable. Identifica qué comparación es causal, observacional o puramente descriptiva. Revisa si existen experimentos simultáneos o cambios de precio que impidan atribuir el efecto.
5. Agrupa fallos por etapa: descubrimiento, entrada, validación, procesamiento, exportación, integración e impresión. Diferencia fallo de usuario, proveedor, datos, producto e infraestructura. Acompaña con conteos y versiones; no pegas el texto libre de un cliente sin desidentificar.
6. Evalúa las acciones de la semana anterior: implementada o no, criterio de éxito observado o pendiente, y efectos no deseados. Una PR abierta no significa una mejora desplegada; desplegar no prueba éxito.
7. Propón como máximo tres acciones. Cada una lleva `actionId`, hipótesis, evidencia, `featureId`, propietario por rol, alcance backend/frontend, dependencia, criterio de aceptación, métrica de resultado, ventana y fecha de revisión.
8. Guarda `coe_weekly.md` y `action_proposals.json`. En el resumen explica qué cambió, qué decisión recomienda la evidencia y qué no se puede concluir.

No concluyas que una función debe retirarse porque todavía no tiene una cohorte madura. Ante una caída técnica importante, propone una mitigación concreta y un análisis de incidente, sin ejecutar cambios de producción desde esta revisión.

## A09 — Revisión independiente · Claude

**Objetivo:** verificar la solidez del COE semanal sin volver a investigar todo el producto.

Lee el informe A08 exacto y los mismos snapshots. Comprueba:

- Que cada cifra importante se pueda reproducir y la ventana sea la correcta.
- Que no se mezclen stock de cuentas y conversión histórica.
- Que una factura/cliente no cuente como varias altas por distintos webhooks o features.
- Que los porcentajes tengan denominadores y excluyan ventanas inmaduras.
- Que los efectos de precio, país, canal, plan y exposición se consideren cuando alteran la comparación.
- Que no se presente correlación como causalidad ni tres pilotos como significancia estadística.
- Que el esfuerzo propuesto responda al problema observado y no duplique funciones ya existentes.
- Que el ticket frontend indique tipos, componentes por localizar y UI sugerida para su repositorio.

Devuelve `coe_review.md` con estado por acción: `supported`, `revise`, `insufficient_data`. Incluye correcciones específicas, evidencia de desacuerdo y preguntas pendientes. No cambies silenciosamente las cifras del informe original. La recomendación se entrega al responsable de producto y queda registrada; no constituye autorización de despliegue.

## A10 — Revisión mensual · Codex

**Objetivo:** decidir qué merece ampliación y qué necesita otra iteración, según suscriptores netos, renovación y coste de servir.

Usa el mes cerrado y las cohortes maduras disponibles. Si una funcionalidad se lanzó a mitad de mes, indícalo y evalúa su horizonte real. Las suscripciones anuales no tienen una renovación mensual observable: informa vigencia y actividad, y espera a su vencimiento para la tasa de renovación.

Presenta:

1. Puente entre cuentas pagas iniciales y finales: primeras altas, reactivaciones, bajas efectivas y ajustes conciliados. Upgrades aparte.
2. Adopción y retención por feature, país/canal cuando haya N suficiente, y plan.
3. Resultados de experimentos según asignación inicial, hipótesis prerregistrada y horizonte. Si no hay potencia suficiente, no declarar ganador.
4. Ingreso observado, reembolsos pertinentes y costes observados/estimados separados: renderer, almacenamiento, conector y soporte. No sumar monedas sin metodología de conversión documentada.
5. Una recomendación por feature: `continue`, `improve`, `expand_candidate`, `pause_expansion_candidate` o `insufficient_data`.
6. Compromisos del siguiente mes con propietario, límites y fecha de revisión.

Guarda `coe_monthly.md` y `decision_proposals.json`. No cambies precios ni cupos para alcanzar una meta. Una recomendación de ampliar requiere datos válidos, experiencia fiable y evaluación de margen, no únicamente más eventos.

## A11 — Contraste de mercado · Grok

**Objetivo:** revisar si aparecieron nuevas necesidades o alternativas que cambien las hipótesis de las mejoras en desarrollo.

El disparador semanal verifica un estado persistente y solo investiga si han pasado al menos 14 días desde la última corrida exitosa. Si no corresponde, devuelve `skipped_not_due`. Un fallo no avanza `lastSuccessfulAt`.

Parte de las hipótesis abiertas del COE. Busca hasta ocho fuentes útiles en X, Reddit, comunidades o documentación oficial. Para cada una guarda enlace directo, fecha, problema, segmento y tipo de evidencia: usuario relatando uso, petición, intención declarada de pago, promoción u oferta comercial. No cuentes la misma persona/publicación repetida como señales independientes.

Comprueba las capacidades/precios de competidores en fuentes oficiales si los citas. No conviertas un precio publicado en compra demostrada ni vistas en suscripciones. Si X no está disponible, explica la limitación. No publiques ni contactes a nadie. No presentes una sugerencia de mercado como hecho de uso de ZPLPDF.

Entrega `market_signals.md` con novedades, contraevidencia y hasta dos hipótesis para validar internamente. No genera automáticamente features nuevas ni altera el orden del backlog.

## Plantilla de una acción COE

```json
{
  "actionId": "coe-<period>-<feature>-<problem>",
  "featureId": "packing_workflow",
  "status": "proposed",
  "evidence": [{"snapshotId": "<real>", "metric": "<real>", "numerator": 0, "denominator": 0}],
  "evidenceClass": "descriptive",
  "problem": "<observable>",
  "hypothesis": "<comprobable>",
  "ownerRole": "backend|frontend|qa|product",
  "targetRepository": "gustavojmarrero/zplpdf_back",
  "scope": "<acotado>",
  "acceptance": ["<resultado observable>"],
  "successMetric": "<definicion>",
  "measurementWindow": "<ventana madura>",
  "reviewAt": "<fecha real>",
  "decision": "pending"
}
```

La plantilla contiene marcadores; cada corrida debe sustituirlos con valores reales o declarar que falta información. Los ceros del ejemplo no son datos de ZPLPDF.


## Ejecución implementada

Ejecutar `node scripts/growth/coe-precheck.mjs A08` (sustituir el ID).
Si termina con código 2, registrar el estado y detener esta corrida sin conclusiones comerciales.
El JSON impreso contiene ventana, runId y outputDirectory reales: escribir allí los archivos
nombrados por el prompt, usando el snapshot cuyo checksum se verificó. Al terminar,
`node scripts/growth/coe-finish.mjs A08` verifica artefactos y escribe receipt.json;
este recibo certifica integridad de archivos, no calidad del razonamiento ni aprobación humana.
A09 requiere el recibo A08 del mismo período y checksum. A11 solo avanza lastSuccessfulAt
al completar sus artefactos. Las corridas terminadas de la misma ventana se omiten.
