import type { Coverage } from './growth-sources.js';

/**
 * Fricciones operativas: rechazos por cuota y errores HTTP de peticiones
 * autenticadas que fallaron.
 *
 * Tres cosas que este agregado **no** es, y que importan más que lo que sí es:
 *
 * 1. **No son operaciones.** Son intentos fallidos. No se restan de los éxitos
 *    ni se suman a ellos: un rechazo por cuota no es una conversión negativa,
 *    es una señal de que alguien quiso trabajar y no pudo.
 * 2. **No es un ledger exhaustivo.** La persistencia es de mejor esfuerzo: si
 *    Firestore falla al anotar la señal, el fallo de negocio del usuario se
 *    respeta y la señal se pierde con un log estático. Por eso la cobertura
 *    máxima es `best_effort` y nunca `complete`.
 * 3. **No cubre la historia.** Sin `GROWTH_OPERATIONAL_SIGNALS_START`, o con
 *    una ventana que empieza antes de esa fecha, no hay cobertura: imputar
 *    historia a partir de cuando se instrumentó convertiría la instrumentación
 *    misma en una caída de errores.
 *
 * Quedan fuera por construcción (el interceptor no los ve): fallos de guard
 * —sin cuenta autenticada no hay a quién atribuirlos— y fallos de trabajadores
 * asíncronos, que no son una petición HTTP de nadie. Ninguno de los dos entra
 * tampoco en los libros de ingreso, coste o renovación.
 */

export type OperationalKind = 'quota_rejected' | 'http_error';

export const OPERATIONAL_CODES = [
  'MONTHLY_LIMIT_EXCEEDED',
  'LABEL_LIMIT_EXCEEDED',
  'BATCH_LIMIT_EXCEEDED',
  'SERVER_FAILURE',
  'REQUEST_REJECTED',
] as const;

export type OperationalCode = (typeof OPERATIONAL_CODES)[number];

export interface OperationalSignal {
  id: string;
  accountId: string;
  featureId: string;
  kind: OperationalKind;
  code: string;
  statusCode: number;
  environment: string;
  isSynthetic?: boolean;
  occurredAt: string;
}

export interface OperationalBreakdown {
  featureId: string;
  kind: OperationalKind;
  code: string;
  attempts: number;
  accounts: number;
}

export interface OperationalSignalsReport {
  schemaVersion: 1;
  window: { start: string; end: string };
  /** `best_effort` es el techo: la anotación puede fallar sin romper la petición. */
  coverage: Coverage | 'best_effort';
  coverageStartedAt: string | null;
  reason?: string;
  quotaRejections: number | null;
  httpErrors: number | null;
  accountsAffected: number | null;
  byCode: OperationalBreakdown[];
  truncated: boolean;
  excludedAccounts: number;
  semantics: 'failed_authenticated_http_attempts_not_operations';
  excludedByDesign: ['guard_failures', 'async_worker_failures'];
}

function missing(
  window: { start: string; end: string },
  reason: string,
  coverageStartedAt: string | null,
): OperationalSignalsReport {
  return {
    schemaVersion: 1,
    window,
    coverage: 'missing_data',
    coverageStartedAt,
    reason,
    // Ausencia de instrumentación no es ausencia de errores.
    quotaRejections: null,
    httpErrors: null,
    accountsAffected: null,
    byCode: [],
    truncated: false,
    excludedAccounts: 0,
    semantics: 'failed_authenticated_http_attempts_not_operations',
    excludedByDesign: ['guard_failures', 'async_worker_failures'],
  };
}

export function summarizeOperationalSignals(input: {
  signals: OperationalSignal[];
  window: { start: string; end: string };
  environment: string;
  /** `GROWTH_OPERATIONAL_SIGNALS_START`: desde cuándo existe la instrumentación. */
  coverageStartedAt: string | undefined;
  truncated: boolean;
  isExcluded?: (accountId: string) => boolean;
}): OperationalSignalsReport {
  const startedAt = input.coverageStartedAt ?? null;

  if (!startedAt || !Number.isFinite(Date.parse(startedAt)))
    return missing(
      input.window,
      'operational_signals_start_not_configured',
      null,
    );

  // La ventana tiene que caer enteramente dentro del período instrumentado.
  if (startedAt > input.window.start)
    return missing(input.window, 'window_precedes_instrumentation', startedAt);

  let excludedAccounts = 0;
  const usable = input.signals.filter((signal) => {
    if (signal.environment !== input.environment) return false;
    if (signal.isSynthetic) return false;
    if (signal.occurredAt < input.window.start) return false;
    if (signal.occurredAt > input.window.end) return false;
    if (input.isExcluded?.(signal.accountId)) {
      excludedAccounts += 1;
      return false;
    }
    return true;
  });

  const groups = new Map<
    string,
    { row: OperationalBreakdown; accounts: Set<string> }
  >();
  for (const signal of usable) {
    const key = `${signal.featureId}|${signal.kind}|${signal.code}`;
    if (!groups.has(key))
      groups.set(key, {
        row: {
          featureId: signal.featureId,
          kind: signal.kind,
          code: signal.code,
          attempts: 0,
          accounts: 0,
        },
        accounts: new Set(),
      });
    const group = groups.get(key);
    group.row.attempts += 1;
    group.accounts.add(signal.accountId);
  }

  return {
    schemaVersion: 1,
    window: input.window,
    // Techo deliberado: con persistencia de mejor esfuerzo no se puede afirmar
    // que estén todos los intentos fallidos.
    coverage: input.truncated ? 'partial' : 'best_effort',
    coverageStartedAt: startedAt,
    ...(input.truncated ? { reason: 'scan_limit' } : {}),
    quotaRejections: usable.filter((signal) => signal.kind === 'quota_rejected')
      .length,
    httpErrors: usable.filter((signal) => signal.kind === 'http_error').length,
    accountsAffected: new Set(usable.map((signal) => signal.accountId)).size,
    byCode: [...groups.values()]
      .map(({ row, accounts }) => ({ ...row, accounts: accounts.size }))
      .sort(
        (a, b) =>
          b.attempts - a.attempts ||
          a.featureId.localeCompare(b.featureId) ||
          a.code.localeCompare(b.code),
      ),
    truncated: input.truncated,
    excludedAccounts,
    semantics: 'failed_authenticated_http_attempts_not_operations',
    excludedByDesign: ['guard_failures', 'async_worker_failures'],
  };
}
