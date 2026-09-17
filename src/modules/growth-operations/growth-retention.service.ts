import { Injectable, Logger } from '@nestjs/common';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import type { Firestore, Query, Transaction } from '@google-cloud/firestore';

/**
 * A12 — limpieza por estado.
 *
 * La decisión central de este servicio es que **no borra documentos**: redacta
 * metadatos. El motivo no es prudencia genérica, es que esos documentos hacen
 * dos trabajos a la vez:
 *
 * - **Son la reserva de idempotencia.** `label_workflow_exports` y
 *   `label_template_runs` se identifican por la intención del cliente. Si el
 *   documento desaparece, una petición repetida con la misma `Idempotency-Key`
 *   ya no encuentra reserva previa, se considera nueva, y vuelve a convertir y a
 *   consumir cuota: un borrado por antigüedad se convierte en un segundo cobro.
 *   Con el documento presente, la repetición de una operación vencida se
 *   rechaza con `OPERATION_EXPIRED`, que es la respuesta correcta.
 * - **Son evidencia contable.** El `jobId`, el estado terminal y el recuento de
 *   etiquetas son lo que explica un cobro. Eso se conserva siempre.
 *
 * Lo que sí se retira es el material pesado o con datos del usuario que ya no
 * hace falta pasada la retención: la copia congelada del lote, la lista de
 * etiquetas, los diagnósticos por fila, el nombre de archivo original y la
 * entrada de un trabajo de API. Cada retirada revalida estado y vencimiento
 * **dentro de la transacción**, porque entre la consulta y la escritura una
 * operación vencida puede haber sido reclamada otra vez.
 *
 * Y nada de TTL ciego: un pendiente, un fallido reintentable o un hecho sin
 * entregar no se tocan, se cuentan y se reportan como atraso para que alguien
 * decida.
 */

/** Retención por defecto cuando el documento no declara `expiresAt`. */
export const DEFAULT_RETENTION_MS = 90 * 86400000;

export type RetentionSkipReason =
  | 'not_terminal'
  | 'not_expired'
  | 'already_redacted'
  | 'reservation_held'
  | 'lease_held'
  | 'retryable_failure'
  | 'accounting_evidence_missing'
  | 'vanished';

export interface TargetOutcome {
  collection: string;
  mode: 'redact' | 'delete';
  scanned: number;
  /** Documentos limpiados: metadatos retirados, o fila borrada en modo `delete`. */
  redacted: number;
  skipped: number;
  skippedByReason: Partial<Record<RetentionSkipReason, number>>;
  nextCursor: string | null;
  truncated: boolean;
}

export interface BacklogEntry {
  collection: string;
  state: string;
  count: number;
  truncated: boolean;
  /** Por qué se conserva en vez de limpiarse. */
  reason: string;
}

export interface RetentionReport {
  schemaVersion: 1;
  generatedAt: string;
  bounded: true;
  limitPerTarget: number;
  targets: TargetOutcome[];
  backlog: BacklogEntry[];
  nextCursors: Record<string, string | null>;
  /** Colecciones cuyos documentos no se borran nunca, ni vencidos. */
  neverDeleted: string[];
  /** Único borrado: la fila de cola de un hecho ya entregado. */
  deletedWhenTerminal: { collection: string; state: string }[];
  /** Campos que sobreviven siempre a la limpieza, y para qué hacen falta. */
  preservedFields: { field: string; purpose: string }[];
  semantics: 'status_aware_cleanup_preserves_reservations_and_accounting';
}

interface TargetSpec {
  collection: string;
  /** Estados terminales que admiten limpieza. */
  terminalStates: string[];
  statusField: string;
  /**
   * `redact` retira campos y conserva el documento; `delete` lo borra.
   *
   * `delete` es la excepción y solo se usa donde el documento no es reserva de
   * idempotencia ni evidencia contable: la fila de cola de un hecho **ya
   * entregado**. Todo lo demás es `redact`.
   */
  mode: 'redact' | 'delete';
  /** Campos que se retiran en modo `redact`. El resto se conserva. */
  redactFields: string[];
  /** Comprobación extra dentro de la transacción. */
  guard?: (
    row: Record<string, any>,
    tx: Transaction,
    db: Firestore,
  ) => Promise<RetentionSkipReason | null>;
}

const REDACTION_MARK = 'metadataRedactedAt';

/** Vencimiento efectivo del documento, en milisegundos. */
function expiryOf(row: Record<string, any>, retentionMs: number): number {
  const declared = row.expiresAt;
  if (declared instanceof Timestamp) return declared.toMillis();
  if (typeof declared === 'string') {
    const parsed = Date.parse(declared);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Sin `expiresAt` se deriva de la creación: no se asume que algo sin fecha
  // esté vencido, ni que sea eterno.
  const created = Date.parse(row.createdAt ?? '');
  return Number.isFinite(created) ? created + retentionMs : Infinity;
}

@Injectable()
export class GrowthRetentionService {
  private readonly logger = new Logger(GrowthRetentionService.name);

  /**
   * Se construye con el cliente ya configurado que le pasa quien lo invoca. No
   * inyecta `FirestoreService` a propósito: así el servicio de jobs de
   * `growth-metrics` puede instanciarlo sin que los dos módulos se importen
   * mutuamente.
   */
  constructor(private readonly db: Firestore) {}

  private targets(): TargetSpec[] {
    return [
      {
        /**
         * Cola de salida de observabilidad. Una fila **entregada** ya no es
         * nada: el hecho está registrado, la deduplicación vive en sus propios
         * recibos y esta fila solo servía para la entrega. Vencida, se borra.
         *
         * Lo que no se toca nunca es `pending`, `leased` y `dead`: son hechos
         * que todavía no se registraron. El barrido por `expiresAt` los borraba
         * a los noventa días, que es justo la evidencia que el outbox existe
         * para conservar.
         */
        collection: 'event_outbox',
        statusField: 'state',
        terminalStates: ['delivered'],
        mode: 'delete',
        redactFields: [],
        guard: async (row) =>
          row.leaseToken || row.availableAt ? 'lease_held' : null,
      },
      {
        collection: 'label_workflow_exports',
        statusField: 'status',
        terminalStates: ['accepted'],
        mode: 'redact',
        /**
         * Material pesado y contexto de repetición. `completionEvent` es la
         * copia embebida del hecho para reintentar la entrega en una
         * repetición; sobre una operación vencida es inalcanzable, porque
         * `reserveOperation` rechaza lo vencido con `OPERATION_EXPIRED` antes
         * de llegar a ella. El `jobId`, el recuento y el estado se quedan.
         */
        redactFields: ['workflowSnapshot', 'labelIds', 'completionEvent'],
        guard: async (row) => (row.leaseToken ? 'lease_held' : null),
      },
      {
        collection: 'label_template_runs',
        statusField: 'status',
        terminalStates: ['accepted'],
        mode: 'redact',
        /**
         * Contexto privado de repetición del tipo real: los diagnósticos
         * llevan valores de fila del archivo, `resolvedMapping` los nombres de
         * sus columnas y `originalFilename` el nombre que puso el usuario.
         * `requestHash` se queda: es un hash, no contenido, y es la identidad
         * con la que se reconoce una repetición.
         */
        redactFields: [
          'diagnostics',
          'resolvedMapping',
          'originalFilename',
          'completionEvent',
        ],
        guard: async (row) => (row.leaseToken ? 'lease_held' : null),
      },
      {
        collection: 'api_job_inputs',
        statusField: 'status',
        mode: 'redact',
        // La entrada no tiene estado: el que manda es el del trabajo, y se lee
        // en el guard dentro de la misma transacción.
        terminalStates: [],
        redactFields: ['secret'],
        guard: async (row, tx, db) => {
          // El id del documento de entrada ES el id del trabajo: no hay campo
          // `jobId` que leer, y asumirlo dejaría el guard sin efecto.
          const job = await tx.get(db.collection('api_jobs').doc(row.id));
          if (!job.exists) return 'vanished';
          const status = job.get('status');
          // Un `failed` se puede reintentar y el reintento **lee esta
          // entrada**: retirarla dejaría el trabajo sin poder recuperarse.
          if (status === 'failed') return 'retryable_failure';
          if (!['succeeded', 'cancelled'].includes(status))
            return 'not_terminal';
          // Mientras el trabajo siga contando en el limitador de la cuenta hay
          // una reserva viva.
          if (job.get('leaseToken') || job.get('availableAt'))
            return 'reservation_held';
          return null;
        },
      },
      {
        collection: 'durable_operations',
        statusField: 'status',
        terminalStates: ['completed'],
        mode: 'redact',
        /**
         * `originalFilename` lo escribe el usuario, `sourcePath` apunta a un
         * objeto que su propio ciclo de vida ya retiró y `recovery` guarda la
         * receta con la que se reharía la conversión: pasada la retención ya no
         * se puede rehacer, así que la receta solo es superficie.
         */
        redactFields: ['originalFilename', 'sourcePath', 'recovery'],
        guard: async (row, tx, db) => {
          // `reserved` significa que la cuota sigue apartada en `usage`.
          if (row.reserved === true) return 'reservation_held';
          if (row.leaseUntil > Date.now()) return 'lease_held';
          // Sin el asiento en el historial no hay evidencia del cobro, así que
          // no se toca nada: primero hay que conciliar.
          const evidence = await tx.get(
            db
              .collection('conversion_history')
              .doc(`operation_${row.id ?? ''}`),
          );
          return evidence.exists ? null : 'accounting_evidence_missing';
        },
      },
    ];
  }

  /**
   * Atrasos que se conservan. Ninguno se limpia: un pendiente puede reanudarse,
   * un fallido reintentarse y un hecho sin entregar todavía debe entregarse.
   */
  private backlogProbes(): {
    collection: string;
    field: string;
    states: string[];
    reason: string;
  }[] {
    return [
      {
        collection: 'label_workflow_exports',
        field: 'status',
        states: ['pending', 'failed'],
        reason: 'operation_resumable_or_retryable',
      },
      {
        collection: 'label_template_runs',
        field: 'status',
        states: ['pending', 'failed'],
        reason: 'operation_resumable_or_retryable',
      },
      {
        collection: 'event_outbox',
        field: 'state',
        // `delivered` no entra: no es atraso, es trabajo terminado y es lo
        // único que esta limpieza borra.
        states: ['pending', 'leased', 'dead'],
        reason: 'fact_not_delivered',
      },
      {
        /**
         * Aquí no hay nada que limpiar, y conviene decir por qué: esta cola
         * **no tiene estado `delivered`**. Al confirmar la entrega, `ack`
         * borra el documento, así que lo único que queda es `pending` (falta
         * entregar) y `dead` (se agotaron los intentos y es la evidencia de un
         * hecho que no se registró). Su `event` tampoco lleva contenido del
         * usuario: el sobre canónico solo transporta identificadores y
         * recuentos. Se cuenta y se conserva.
         */
        collection: 'label_event_retries',
        field: 'status',
        states: ['pending', 'dead'],
        reason: 'fact_not_delivered',
      },
      {
        collection: 'api_jobs',
        field: 'status',
        states: ['queued', 'running', 'failed'],
        reason: 'job_pending_or_retryable',
      },
      {
        collection: 'durable_operations',
        field: 'status',
        states: ['processing'],
        reason: 'quota_reservation_in_flight',
      },
    ];
  }

  async cleanup(
    options: {
      limitPerTarget?: number;
      cursors?: Record<string, string | null>;
      retentionMs?: number;
      now?: Date;
    } = {},
  ): Promise<RetentionReport> {
    const limitPerTarget = Math.min(
      Math.max(options.limitPerTarget ?? 200, 1),
      500,
    );
    const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    const now = options.now ?? new Date();
    const cursors = options.cursors ?? {};

    const targets: TargetOutcome[] = [];
    for (const spec of this.targets())
      targets.push(
        await this.sweep(spec, {
          limitPerTarget,
          retentionMs,
          now,
          cursor: cursors[spec.collection] ?? null,
        }),
      );

    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      bounded: true,
      limitPerTarget,
      targets,
      backlog: await this.backlog(limitPerTarget),
      nextCursors: Object.fromEntries(
        targets.map((target) => [target.collection, target.nextCursor]),
      ),
      /**
       * Lo que este servicio nunca borra, ni siquiera vencido. `event_outbox`
       * NO está aquí: su fila entregada sí se borra, y decir lo contrario en el
       * propio informe sería la clase de promesa que el código no cumple.
       */
      neverDeleted: [
        'label_workflow_exports',
        'label_template_runs',
        'api_jobs',
        'api_job_inputs',
        'durable_operations',
        'label_event_retries',
        'conversion_history',
        'billing_facts',
      ],
      deletedWhenTerminal: [{ collection: 'event_outbox', state: 'delivered' }],
      preservedFields: [
        {
          field: 'accountId',
          purpose: 'account_deletion_sweep_and_ownership',
        },
        {
          field: 'intentHash',
          purpose: 'idempotency_rejects_replay_as_expired',
        },
        { field: 'idempotencyKey', purpose: 'idempotency_identity' },
        { field: 'requestHash', purpose: 'replay_identity_hash_not_content' },
        { field: 'status', purpose: 'terminal_state_evidence' },
        { field: 'jobId', purpose: 'accounting_evidence' },
        { field: 'labelCount', purpose: 'accounting_evidence' },
        { field: 'expiresAt', purpose: 'retention_decision' },
      ],
      semantics: 'status_aware_cleanup_preserves_reservations_and_accounting',
    };
  }

  private async sweep(
    spec: TargetSpec,
    context: {
      limitPerTarget: number;
      retentionMs: number;
      now: Date;
      cursor: string | null;
    },
  ): Promise<TargetOutcome> {
    const outcome: TargetOutcome = {
      collection: spec.collection,
      mode: spec.mode,
      scanned: 0,
      redacted: 0,
      skipped: 0,
      skippedByReason: {},
      nextCursor: null,
      truncated: false,
    };

    // Página acotada y ordenada por id: el cursor es el último id visto, así
    // que repetir la ejecución avanza en vez de volver a mirar lo mismo.
    let query: Query = this.db
      .collection(spec.collection)
      .orderBy('__name__')
      .limit(context.limitPerTarget);
    if (context.cursor) query = query.startAfter(context.cursor);

    const page = await query.get();
    outcome.scanned = page.size;
    outcome.truncated = page.size === context.limitPerTarget;
    outcome.nextCursor = page.empty
      ? null
      : (page.docs[page.docs.length - 1].id ?? null);

    for (const doc of page.docs) {
      const reason = await this.redact(doc.id, spec, context);
      if (reason === null) outcome.redacted += 1;
      else {
        outcome.skipped += 1;
        outcome.skippedByReason[reason] =
          (outcome.skippedByReason[reason] ?? 0) + 1;
      }
    }

    return outcome;
  }

  /**
   * Retira los metadatos de un documento, revalidando estado y vencimiento
   * dentro de la transacción.
   *
   * La revalidación no es ceremonia: entre la consulta de la página y esta
   * escritura, una operación vencida puede haber sido reclamada de nuevo y
   * volver a `pending` con un lease vivo. Decidir con los datos de la consulta
   * retiraría los metadatos de una operación que está corriendo.
   */
  private async redact(
    id: string,
    spec: TargetSpec,
    context: { retentionMs: number; now: Date },
  ): Promise<RetentionSkipReason | null> {
    const ref = this.db.collection(spec.collection).doc(id);

    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return 'vanished';
      const row = snapshot.data();

      if (row[REDACTION_MARK]) return 'already_redacted';

      if (
        spec.terminalStates.length > 0 &&
        !spec.terminalStates.includes(row[spec.statusField])
      )
        return 'not_terminal';

      if (!(expiryOf(row, context.retentionMs) <= context.now.getTime()))
        return 'not_expired';

      const blocked = await spec.guard?.({ ...row, id }, tx, this.db);
      if (blocked) return blocked;

      if (spec.mode === 'delete') {
        // Solo aquí se borra, y solo tras revalidar estado y vencimiento en
        // esta misma transacción.
        tx.delete(ref);
        return null;
      }

      const present = spec.redactFields.filter((field) => field in row);
      if (present.length === 0) {
        // Nada que retirar: se marca igual para no volver a mirarlo.
        tx.update(ref, {
          [REDACTION_MARK]: context.now.toISOString(),
          retentionState: 'metadata_redacted',
        });
        return null;
      }

      tx.update(ref, {
        ...Object.fromEntries(
          present.map((field) => [field, FieldValue.delete()]),
        ),
        [REDACTION_MARK]: context.now.toISOString(),
        retentionState: 'metadata_redacted',
        // Qué se retiró, para poder explicar un documento incompleto sin
        // adivinar si nunca tuvo esos campos.
        redactedFields: present,
      });
      return null;
    });
  }

  /** Recuento acotado de lo que se conserva, por colección y estado. */
  private async backlog(limit: number): Promise<BacklogEntry[]> {
    const entries: BacklogEntry[] = [];

    for (const probe of this.backlogProbes()) {
      for (const state of probe.states) {
        const rows = await this.db
          .collection(probe.collection)
          .where(probe.field, '==', state)
          .limit(limit + 1)
          .get();
        if (rows.empty) continue;
        entries.push({
          collection: probe.collection,
          state,
          count: Math.min(rows.size, limit),
          // Un recuento truncado se declara: «al menos N», nunca «exactamente N».
          truncated: rows.size > limit,
          reason: probe.reason,
        });
      }
    }

    if (entries.length)
      this.logger.warn(
        `A12 conserva ${entries.length} grupos de documentos no limpiables`,
      );

    return entries;
  }
}
