# A12 — contrato de retención por estado

Estado: implementado en `src/modules/growth-operations/growth-retention.service.ts` e invocado desde el job `retention` de `src/modules/growth-metrics/growth-jobs.service.ts`. **Ningún job creado ni habilitado, nada ejecutado contra producción.**

## 1. La decisión central: se retiran metadatos, con una sola excepción

Los documentos que A12 tiene que limpiar hacen dos trabajos a la vez, y por eso un borrado por antigüedad es peligroso:

- **Son la reserva de idempotencia.** `label_workflow_exports` y `label_template_runs` se identifican por la intención del cliente. Si el documento desaparece, una petición repetida con la misma `Idempotency-Key` ya no encuentra reserva previa: se considera nueva, vuelve a convertir y **vuelve a consumir cuota**. Un TTL ciego se convierte en un segundo cobro. Con el documento presente, la repetición de una operación vencida se rechaza con `OPERATION_EXPIRED`, que es la respuesta correcta.
- **Son evidencia contable.** El `jobId`, el estado terminal y el recuento de etiquetas son lo que explica un cargo.

Así que la limpieza **retira campos** y deja el documento con su identidad:

```ts
{ ...identidad y evidencia,
  metadataRedactedAt: '2026-09-18T00:00:00.000Z',
  retentionState: 'metadata_redacted',
  redactedFields: ['workflowSnapshot', 'labelIds'] }
```

`redactedFields` existe para poder explicar un documento incompleto sin tener que adivinar si esos campos existieron alguna vez.

**La única excepción es la fila de cola de un hecho ya entregado** (`event_outbox` en `delivered`): ahí el documento no es reserva ni evidencia —el hecho está registrado y la deduplicación vive en sus propios recibos— así que se borra. El informe lo declara en `deletedWhenTerminal` y **no** incluye `event_outbox` en `neverDeleted`, porque prometer en el informe una protección que el código no da es el error que esta tarea vino a corregir.

## 2. Cobertura exacta

| Colección | Se retira | Condición (revalidada en transacción) |
|---|---|---|
| `event_outbox` | **la fila entera** (único borrado) | `state === 'delivered'`, vencida, sin `leaseToken` ni `availableAt` |
| `label_workflow_exports` | `workflowSnapshot`, `labelIds`, `completionEvent` | `status === 'accepted'`, vencido, sin `leaseToken` |
| `label_template_runs` | `diagnostics` (valores de fila del archivo), `resolvedMapping` (nombres de sus columnas), `originalFilename` (texto del usuario), `completionEvent` | `status === 'accepted'`, vencido, sin `leaseToken` |
| `api_job_inputs` | `secret` (la entrada del cliente) | el trabajo asociado está `succeeded` o `cancelled`, sin `leaseToken` ni `availableAt`, y la entrada vencida |
| `durable_operations` | `originalFilename` (texto del usuario), `sourcePath` (objeto ya retirado por su ciclo de vida), `recovery` (la receta de reconversión) | `status === 'completed'`, `reserved !== true`, lease caducado, y **existe** `conversion_history/operation_<id>` |

El vencimiento sale de `expiresAt` (nativo `Timestamp` o ISO). Si el documento no lo declara, se deriva de `createdAt + 90 días`: no se asume que algo sin fecha esté vencido ni que sea eterno.

Dos decisiones sobre campos concretos, porque no son obvias:

- **`completionEvent` se retira.** Es la copia embebida del hecho que la repetición de una operación ya aceptada usa para reintentar la entrega. Sobre una operación vencida es inalcanzable: `reserveOperation` llama a `assertOperationUnexpired` **antes** de cualquier otra cosa, así que la repetición se rechaza con `OPERATION_EXPIRED` y nunca llega a leerla. Lo que queda por entregar vive en la cola, que está protegida.
- **`requestHash` se conserva.** Es un hash, no contenido, y es la identidad con la que se reconoce una repetición. Retirarlo no protegería a nadie y sí rompería el reconocimiento.
- **`recovery` se retira.** Pasada la retención la conversión ya no se puede rehacer —la fuente la borró su propio ciclo de vida a los 15 días—, así que la receta solo es superficie.

### Campos que sobreviven siempre

El informe los declara en `preservedFields` con su motivo, para que nadie los añada a una limpieza futura por descuido:

| Campo | Para qué hace falta |
|---|---|
| `accountId` | barrido por borrado de cuenta y comprobación de propiedad |
| `intentHash`, `idempotencyKey`, `requestHash` | idempotencia: sin ellos una repetición se toma por nueva |
| `status` | evidencia del estado terminal |
| `jobId`, `labelCount` | evidencia contable de lo que se cobró |
| `expiresAt`, `createdAt` | decidir la retención en la vuelta siguiente |

## 3. Lo que nunca se borra ni se toca

| Caso | Por qué |
|---|---|
| Operaciones `pending` | Pueden reanudarse; su lease puede estar vivo |
| Operaciones `failed` | Son reintentables y su reintento **lee la entrada** |
| `api_jobs` en `queued`/`running`/`failed` | Cuentan en el limitador por cuenta o admiten reintento |
| `durable_operations` con `reserved: true` | La cuota sigue apartada en `usage.reservedPdfCount` |
| `durable_operations` sin asiento en `conversion_history` | Falta la evidencia del cobro: primero hay que conciliar |
| `event_outbox` en `pending`/`leased`/`dead` | Es un hecho que todavía no se registró. `delivered` sí se borra: ver §2 |
| `label_event_retries` **entera** | No tiene estado `delivered`: `ack` borra el documento al confirmar la entrega, así que lo único que queda es `pending` (falta entregar) y `dead` (evidencia de un hecho que no se registró). Su campo `event` tampoco lleva contenido del usuario: el sobre canónico solo transporta identificadores y recuentos. No hay payload privado que retirar, y borrarlo destruiría evidencia sin mejorar nada |
| `conversion_history`, `billing_facts`, agregados financieros | Evidencia de lo que se cobró y de lo que se afirmó |
| `drive_revocations`/`drive_oauth_states` pendientes, credenciales | Guardan un secreto pendiente de revocar |

Todos se cuentan y se publican en `backlog` con su motivo (`operation_resumable_or_retryable`, `fact_not_delivered`, `job_pending_or_retryable`, `quota_reservation_in_flight`). **Un atraso se clasifica, nunca se resuelve borrando.**

## 4. Bug corregido en el barrido anterior

`event_outbox` estaba en la lista del barrido ciego por `expiresAt` del job `retention`. Sus documentos nacen con `expiresAt` (`receivedAt + 90 días`) **y** con estado, así que a los noventa días se borraba un hecho que **seguía sin entregar** —justo la evidencia que el diseño del outbox existe para conservar—.

Ahora pasa por la capa por estado, y ahí el estado manda: `settle` con éxito deja la fila en `state: 'delivered'` (no la borra), así que **lo entregado y vencido sí se borra** —es el único documento que esta limpieza borra, porque una fila entregada no es reserva de idempotencia ni evidencia contable: la deduplicación vive en sus propios recibos y el hecho ya está registrado—. `pending`, `leased` y `dead` no se tocan nunca, y una fila que vuelva a `pending` entre la consulta y la transacción se salva por la revalidación.

El barrido ciego queda solo para colecciones cuyo contenido es dato de medición, donde perder una fila vencida no borra ninguna reserva ni evidencia de cobro: `product_events`, `product_event_dedup`, `growth_event_facts` y `growth_operational_signals`.

## 5. Límites, cursor y repetición

- **Acotado por vuelta:** 200 documentos por objetivo (configurable, sujeto a `1..500`) y 400 por colección en el barrido ciego. El resto espera la siguiente ejecución.
- **Cursor real:** cada objetivo se pagina por id (`orderBy('__name__')` + `startAfter`), y el último id visto se devuelve en `nextCursors`. El job lo guarda en `growth_retention_state/latest` **dentro de la publicación con fence**, así que un lease vencido no puede adelantar el cursor de otro proceso.
- **Repetible:** un documento ya retirado se salta por `already_redacted`; repetir la vuelta no vuelve a escribirlo.
- **Recuentos honestos:** el atraso se lee con `limit + 1` y publica `truncated: true` cuando hay más. Es «al menos N», nunca «exactamente N».

## 6. Carreras

Cada retirada abre su propia transacción y **vuelve a leer el documento** antes de escribir. No es ceremonia: entre la consulta de la página y la escritura, una operación vencida puede haber sido reclamada otra vez y estar de nuevo en `pending` con un lease vivo. Decidir con los datos de la consulta le retiraría los metadatos a una operación que está corriendo. Las pruebas simulan exactamente esa ventana.

## 7. Evidencia

28 pruebas unitarias en `src/modules/growth-operations/growth-retention.service.spec.ts`, 2 de integración del job en `src/modules/growth-metrics/growth-aggregate.spec.ts` y 12 contra el emulador real (§8).

| Qué se prueba | |
|---|---|
| Retira lo pesado y conserva identidad y evidencia | el documento sigue existiendo, con `jobId`, `status` e `intentHash` |
| Pendiente y fallido intactos, y reportados | `not_terminal` + entradas de `backlog` |
| No vencido intacto | `not_expired` |
| Sin `expiresAt` deriva de `createdAt` | 100 días sí, 1 día no |
| Entrada de trabajo fallido conservada | `retryable_failure`: el reintento la necesita |
| Entrada retirada solo con trabajo terminal y sin reserva | `reservation_held` frente a retirada |
| Operación durable con cuota reservada o sin asiento, intacta | `reservation_held`, `accounting_evidence_missing` |
| Colas de hechos reportadas, nunca borradas | `fact_not_delivered` + `neverDeleted` |
| **Carrera:** reclamada de nuevo entre consulta y transacción | la revalidación la protege |
| Documento que desaparece a mitad | `vanished`, la vuelta no se rompe |
| Límite, truncado y avance del cursor | 3 documentos con límite 2: dos vueltas |
| Límite acotado arriba y abajo | `0 → 1`, `100000 → 500` |
| El barrido ciego ya no toca `event_outbox` | el pendiente vencido sobrevive y se reporta |
| Entregado y vencido se borra; pending/leased/dead no | modo `delete` solo en el estado terminal |
| Entregado con lease o turno vivo, intacto | `lease_held` |
| **Carrera:** entregado que vuelve a `pending` | la revalidación evita el borrado |
| El cursor se persiste con el fence del job | `growth_retention_state/latest` |

## 8. Pruebas contra el emulador real

Doce pruebas en `test/growth-retention-emulator.test.ts` (configuración `test/growth-retention-emulator.jest.json`) contra el emulador de Firestore en `127.0.0.1:8085`, proyecto `demo-zplpdf-growth`. Aquí no hay dobles: las transacciones, `FieldValue.delete()`, el borrado de documento y la paginación por `__name__` los ejecuta el emulador.

```
JAVA_HOME=".local/tooling/jdk/jdk-21.0.12.1+1/Contents/Home" \
  npx --yes firebase-tools@15.30.1 emulators:exec --only firestore \
  --project demo-zplpdf-growth --config test/firebase-emulator.json \
  "npx jest --config test/growth-retention-emulator.jest.json --runInBand"
```

| Prueba real | Qué demuestra |
|---|---|
| Retira el contexto privado y conserva reserva, cuota y evidencia | `accountId`, `idempotencyKey`, `intentHash`, `status`, `jobId` y `labelCount` intactos |
| Los tres campos privados reales de una ejecución | `diagnostics`, `resolvedMapping` y `originalFilename` fuera; `requestHash` dentro |
| La receta durable solo con evidencia presente | sin asiento en `conversion_history` o con `reserved: true`, no se toca |
| No toca lo pendiente ni lo no vencido | `not_terminal` y `not_expired`, con entrada en `backlog` |
| Outbox: se borra la entregada, sobreviven `pending` y `dead` | el único borrado, y la evidencia se queda |
| La cola de etiquetas se conserva entera | no hay estado `delivered` que limpiar |
| Entrada de trabajo fallido conservada | el reintento la necesita |
| **Dos clientes limpiando a la vez** | dos conexiones distintas en paralelo: el total de retiradas es exactamente 1 y el documento no se corrompe |
| **Revalidación real:** otro cliente la devuelve a `pending` | la transacción ve el cambio confirmado y no la toca |
| Repetición | `already_redacted`, `metadataRedactedAt` no cambia |
| Cursor y páginas | 3 documentos con límite 2, cursor comprobado, ninguno procesado dos veces |
| No pierde cuota ni evidencia | el asiento contable y el `labelCount` siguen ahí |

## 9. Pendientes reales

1. **Limpieza por borrado de cuenta.** Fuera de este alcance por decisión del coordinador: resuelta por root en `cache` y validada en su suite de67pruebas. Este servicio no borra por cuenta y no intenta suplirlo.
2. **`drive_revocations` y credenciales** se declaran protegidos pero su liquidación es de sus dueños; A12 solo los cuenta.
3. **Sin invocación programada.** El job `retention` existe y llama a esta limpieza, pero Scheduler está declarado y validado en infra/growth; no se ha aplicado ni habilitado.
