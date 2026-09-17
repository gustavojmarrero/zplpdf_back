# BE11 — Tour de novedades persistido: evidencia

Contrato tipado: `docs/growth/product-updates-contract.md` (publicado primero y enviado a root al
inicio, antes de implementar, para que el frontend trabajara en paralelo).

## Qué se implementó

`src/modules/product-updates/` (módulo nuevo) y su registro en `src/app.module.ts`:

| Archivo | Responsabilidad |
|---|---|
| `release-config.ts` | Hoja sin dependencias del módulo: valida `PRODUCT_UPDATES_RELEASE`, aplica aprobación/entorno/fecha y valida metadata de tour para la analítica de root |
| `product-updates.types.ts` | Contrato tipado, rangos de estado, claves i18n, enum de `routeKey`, hash del id de documento y huella de evento |
| `tour-progress.ts` | Reductor puro: duplicado → CAS → transición monótona |
| `tour-progress.repository.ts` | Transacción Firestore (lápida → lectura → escritura) e hidratación defensiva |
| `product-updates.service.ts` | Manifiesto (config + flags), política de invitación y mapeo HTTP |
| `product-updates.controller.ts` | `GET /api/users/me/product-updates`, `PATCH /api/users/me/product-updates/:releaseId/:tourVersion/progress`, ambos con `FirebaseAuthGuard` |
| `product-updates.module.ts` | Consume `FeatureFlagsService` y el cliente Firestore ya configurado, sin duplicar providers |

No se editó `feature-flags.service.ts` ni `feature-entitlements.ts` (propiedad de root), ni el
frontend. Las preguntas de contrato se resolvieron por mensaje antes de escribir código.

## Correcciones de revisión aplicadas (root, 22:24–22:39)

| Corrección | Dónde |
|---|---|
| `docId = sha256(JSON.stringify([uid, releaseId, tourVersion]))`, no concatenación: un uid con barras o con los mismos separadores no puede colisionar con otra identidad | `product-updates.types.ts` (`progressDocId`) |
| `invitationSuppressed` persistente y terminal-monótono: lo fijan `skip`/`complete`, `replay` **no** lo limpia y el GET decide la invitación con esa bandera, no solo con `state` | `tour-progress.ts`, `product-updates.service.ts`, expuesto en `progress` |
| Ventana de idempotencia con `{ eventId, fingerprint(action, stepId, expectedRevision) }`: mismo id con otro cuerpo ⇒ `409 event_id_reused`, nunca duplicado silencioso | `product-updates.types.ts` (`tourEventFingerprint`), `tour-progress.ts` |
| `routeKey` enum definitivo acordado con el frontend: `workflows`, `templates`, `pdf`, `integrations`, `printing`, `regression`, `api` | `product-updates.types.ts` (`CANONICAL_ROUTE_KEYS`) |
| `shouldInvite` acepta `steps.length > 0` **o** `upgrades.length > 0`, para que Free y Lite reciban el resumen de lo ya publicado; `no_available_features` solo con ambos vacíos | `product-updates.service.ts` (`decideInvitation`) |

Además, `environment` pasa a enum cerrado (`development` | `test` | `staging` | `production`) y se
compara siempre; `releasedAt` exige ISO 8601 en UTC explícito y calendario real (`parseIsoUtc`), en
vez de `Date.parse`, que aceptaba strings ambiguos y "corregía" fechas imposibles; `start`/`close`/`skip`/`complete`/`replay` no requieren `stepId` (solo `view_step`),
así el resumen se puede operar sin abrir ningún paso.

## Decisiones que cambian el comportamiento observable

1. **Nada se anuncia como liberado por el hecho de existir.** El tour está construido, pero se
   presenta solo si hay una config aprobada en servidor (`enabled` explícito, entorno coincidente,
   `releasedAt` pasado) **y** la feature está disponible según flags. La variable no está puesta en
   ningún entorno: hoy el endpoint responde `release: null`.
2. **`available` manda para los pasos; `released` manda para los upgrades.** Un piloto
   (`rolloutPercent < 100`) muestra el paso al usuario en treatment, porque el release aprobado es
   lo que certifica despliegue en ese entorno. El aviso de upgrade exige `released && !entitled`,
   para no vender un plan que aún no daría acceso. Todo lo demás se omite: kill switch, variante
   control, plan fuera de `allowedPlans` o feature fuera de `releasedFeatureIds`.
3. **La config no transporta texto ni URLs.** Los textos son claves i18n deterministas y el destino
   es un `routeKey` de lista cerrada en código. Una config manipulada no puede inyectar copy ni
   destinos, y los upgrades no llevan destino alguno: información honesta, nunca navegación a un
   espacio de trabajo prohibido. El único verbo del contrato es navegar; no expone convertir,
   imprimir, conectar Drive, crear claves ni cobrar.
4. **La allowlist de `stepId` del PATCH es la de la config, no el subconjunto filtrado por flags.**
   Registrar que un paso se vio es contabilidad operativa y no concede acceso; si la allowlist
   siguiera a los flags, apagar una flag a mitad del tour rompería el progreso ya empezado.
5. **El duplicado se resuelve antes del CAS, y solo si el cuerpo coincide.** Un reintento cuya
   respuesta se perdió confirma con `200 { duplicate: true }`; el mismo `eventId` con otra acción,
   otro paso u otra revisión esperada responde `409 event_id_reused`. La ventana es de 50 entradas y
   acota el documento; un duplicado más viejo choca en el CAS, que es la respuesta segura.
6. **Sin TTL.** `skipped`/`completed` deben suprimir invitaciones indefinidamente, así que el
   borrado es por cuenta (`accountId` top-level) y no por vencimiento.
7. **Progreso ilegible no se reinterpreta.** Un documento con forma inesperada aborta en lugar de
   sobrescribirse: sobrescribirlo podría borrar un estado terminal y devolver invitaciones ya
   suprimidas. En el GET eso degrada a `progress_unavailable` con `shouldInvite: false` (sin
   progreso confiable no se invita); en el PATCH es un 503 explícito.
8. **Repetir no borra historial ni devuelve la invitación.** `replay` apila el estado terminal
   previo en `terminalHistory` (máx. 20), incrementa `replays`, conserva `visitedStepIds`,
   `completedAt` y `skippedAt`, y deja `invitationSuppressed` en `true`. Abrir sesión de nuevo es
   una decisión del usuario, no una razón para volver a invitarle.

## Trampas encontradas (útiles fuera de este módulo)

- **`strictNullChecks: false` rompe el estrechamiento por discriminante booleano.** Con la config
  del repo, `result.ok ? result.release : null` no compila contra
  `{ ok: true; release } | { ok: false; reason }`. Comprobado con un probe aislado de `tsc`. Por eso
  `ReleaseConfigResult` es una interfaz plana `{ ok, release, reason }`, que es además la forma que
  ya consume `product-observability.service.ts:111`. Un discriminante de cadena (`kind`) sí estrecha:
  es lo que usa el reductor.
- El `HttpExceptionFilter` global reempaqueta las excepciones, así que los códigos de error del
  contrato viajan en `error` y el detalle del conflicto en `data`, no en la raíz.

## Pruebas

Dobles solo donde no hay nada que probar del proveedor: `FeatureFlagsService`, `FirestoreService`
(perfil de cuenta) y `ConfigService`. La concurrencia se probó contra el emulador REAL.

```
npx jest src/modules/product-updates src/app-wiring.spec.ts src/modules/product-observability src/modules/growth-metrics/tour-metrics.spec.ts src/modules/cache/firestore.service.spec.ts
→ 10 suites, 191 tests, todos en verde
```

- `release-config.spec.ts` (6): orden de pasos por `order`; ausencia y config inválida separadas y
  ninguna anunciable; 30 formas inválidas (ids con mayúsculas o vacíos, `enabled` no booleano,
  entorno vacío, no string o fuera del enum (`prod`, `PRODUCTION`), `releasedAt` sin zona, con
  offset, solo fecha, en texto libre o con calendario imposible (`2026-02-31`, `2026-13-01`,
  `2026-09-01T25:00`), `releasedFeatureIds` vacío/duplicado/desconocido,
  paso que apunta a una feature no liberada, `stepId` duplicado, `order` duplicado o fraccionario,
  `anchorId` con espacios, 13 pasos); deshabilitado por defecto; `environment_mismatch` y
  `release_not_yet_published`; metadata de tour inventada rechazada, y `null` ⇒ nada conocido;
  fecha de publicación aceptada solo en UTC y normalizada a milisegundos;
  además `docs/growth/product-updates-release.disabled.json` (el template que copiará ops) se valida
  contra el parser: hoy queda `release_disabled` y, con `enabled: true`, aprobaría sus 7 pasos.
- `tour-progress.spec.ts` (11): unión de pasos visitados y última posición; cerrar conserva posición;
  duplicado resuelto antes del CAS; revisión obsoleta sin tocar el registro; ningún estado terminal
  se rebaja (`start`/`close`/`skip` sobre `completed`, `close`/`start` sobre `skipped`, y `complete`
  sí progresa sobre `skipped`); paso visto tras terminar sin reabrir; `replay` apila historial y
  conserva fechas; `replay` sobre tour nuevo equivale a `start`; ventana de idempotencia acotada; `eventId` reutilizado
  con otro cuerpo (otra acción, otro paso u otra revisión esperada) ⇒ `event_conflict` sin tocar el
  registro, y con el mismo cuerpo ⇒ `duplicate`; `invitationSuppressed` sobrevive a `replay` y a
  `close`, y ni `start` ni `close` lo fijan.
- `product-updates.service.spec.ts` (19): entrada permanente con release ausente/inválido/
  deshabilitado/de otro entorno/no publicado; paso accionable con `routeKey` y claves exactas; paso
  de piloto con `released: false`; downgrade de plan → el paso se convierte en upgrade sin
  navegación; kill switch y variante control omitidos; no invita a registrados después del release
  ni con `createdAt` ausente/inválido, sí con `Timestamp` sin convertir; un plan con cero pasos y
  upgrades publicados **sí** recibe invitación al resumen y ninguna de sus tarjetas lleva `routeKey`;
  `skipped`/`completed` suprimen la invitación y la supresión persiste tras `replay`
  (`invitation_suppressed`); cerrar deja `resume_available` con la
  posición; progreso corrupto ⇒ `progress_unavailable`; aislamiento entre cuentas; 404 de release
  desconocido/deshabilitado; allowlist de `stepId` independiente de flags; reintento confirmado;
  `409 revision_conflict` con la revisión real y `409 event_id_reused` al reutilizar un `eventId`;
  lápida de cuenta bloquea la escritura sin dejar documento; el documento guardado solo tiene campos
  de contabilidad, ningún TTL, y su id es un hash de 64 hex que no contiene la cuenta.
- `product-updates.routes.spec.ts` (1): las dos rutas responden `401` (no `404`) sin token y con
  token forjado, con el módulo real compilado por Nest.

### Emulador real de Firestore

```
JAVA_HOME=.local/tooling/jdk/jdk-21.0.12.1+1/Contents/Home npx --yes firebase-tools@15.30.1 emulators:exec --only firestore --project demo-zplpdf-growth --config test/firebase-emulator.json 'FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npx jest --config test/product-updates-emulator.jest.json'
→ 5 tests en verde (test/product-updates-emulator.test.ts)
```

Con dos clientes Firestore distintos, contra `127.0.0.1:8085`, proyecto `demo-zplpdf-growth`:

1. Dos escritores concurrentes con el mismo `expectedRevision`: exactamente uno aplica y el otro
   recibe conflicto; la revisión almacenada avanza una sola vez. Firestore reintenta la transacción
   del perdedor, esta relee la revisión ya confirmada y el CAS la rechaza: no hay doble aplicación.
2. Reintento del mismo `eventId` desde otra conexión y con la revisión vieja: confirma como
   duplicado, `revision` sigue en 1 y el paso visitado no se duplica.
3. `replay` real: estado `started`, `replays: 1`, historial terminal conservado y `completedAt`
   intacto.
4. Cuenta con lápida: la escritura se rechaza con 401 y no queda documento de progreso.
5. Dos cuentas con el mismo `releaseId`/`tourVersion` no se ven entre sí, y sus ids de documento no
   coinciden ni contienen la cuenta.

La suite limpia sus propios documentos (prefijo sintético por ejecución) y no toca fixtures
compartidos. Antes de arrancar el emulador se comprobó que el puerto 8085 estaba libre y se avisó a
root por mensaje, por ser instancia única.

### Calidad

- `npx tsc --noEmit -p tsconfig.json` → limpio en todo el repo.
- `npx eslint` sobre `src/modules/product-updates/**`, `test/product-updates-emulator.test.ts` y
  `src/app.module.ts` → limpio.
- No se ejecutó la suite completa de jest: el guardián del repo la reserva para el paso previo al
  PR, que es de root. Se ejecutaron en cambio las suites en riesgo por este cambio (`app-wiring`, que
  monta `AppModule` con el módulo nuevo registrado, `product-observability`, que importa
  `release-config.ts`, y `growth-metrics/tour-metrics`, que agrega los eventos `tour_*`).

## Lo que no se hizo, a propósito

- Sin commits: root revisa y commitea.
- Sin despliegue ni activación de flags o cron; `PRODUCT_UPDATES_RELEASE` no se define en ningún
  entorno, así que en producción el endpoint no anuncia nada.
- Sin llamadas a proveedores externos.
- Sin ediciones de frontend ni de código compartido de root, salvo el registro del módulo en
  `src/app.module.ts`, que el alcance pedía explícitamente.

## Estado de lo compartido

1. **Limpieza por borrado de cuenta**: hecha por root — `product_tour_progress` está en
   `anonymizeUserActivityRecords`, que consulta `where('accountId','==',uid)`. El id por hash no la
   afecta: la búsqueda es por campo, no por prefijo. Comprobado ejecutando
   `src/modules/cache/firestore.service.spec.ts` junto a mis suites.
2. **Enum de analítica**: hecho por root (`TOUR_EVENTS` + `releaseId`/`tourVersion`/`tourStepId` en
   `observability.types.ts`), y su validación de metadata usa mi helper puro. El backend no emite
   ninguno de esos eventos ni exige consentimiento analítico para persistir progreso.
3. **CI**: root añadió `test/product-updates-*` a `growth-qa`; no lo toqué.
4. **Pendiente de producto**: publicar el release solo cuando exista despliegue probado en ese
   entorno (`enabled: true`, `environment` correcto y `releasedFeatureIds` limitado a lo realmente
   liberado).
