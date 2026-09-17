import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import { PRODUCT_OBSERVABILITY_FIRESTORE } from '../product-observability/firestore.provider.js';
import {
  PRODUCT_TOUR_PROGRESS_COLLECTION,
  TOUR_STATES,
  emptyProgress,
  progressDocId,
} from './product-updates.types.js';
import type { TourProgressRecord, TourState } from './product-updates.types.js';
import { applyTourAction } from './tour-progress.js';
import type {
  TourProgressCommand,
  TourProgressOutcome,
} from './tour-progress.js';

const DELETED_ACCOUNTS = 'deleted_accounts';

const isIsoOrNull = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' && Number.isFinite(Date.parse(value)));

const isoOrNull = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;

@Injectable()
export class TourProgressRepository {
  constructor(
    @Inject(PRODUCT_OBSERVABILITY_FIRESTORE) private readonly db: Firestore,
  ) {}

  private doc(accountId: string, releaseId: string, tourVersion: string) {
    return this.db
      .collection(PRODUCT_TOUR_PROGRESS_COLLECTION)
      .doc(progressDocId(accountId, releaseId, tourVersion));
  }

  /**
   * Un documento ilegible no se reinterpreta a medias: sobrescribirlo podría
   * borrar un estado terminal y devolver invitaciones ya suprimidas.
   */
  private hydrate(
    data: Record<string, any>,
    accountId: string,
    releaseId: string,
    tourVersion: string,
  ): TourProgressRecord {
    const invalid = () =>
      new ServiceUnavailableException({
        error: 'tour_progress_unreadable',
        message: 'Stored tour progress has an unexpected shape',
      });
    if (data.accountId !== accountId)
      // Aislamiento por cuenta: el uid sale del token, nunca del path.
      throw new UnauthorizedException();
    if (data.releaseId !== releaseId || data.tourVersion !== tourVersion)
      throw invalid();
    if (!TOUR_STATES.includes(data.state as TourState)) throw invalid();
    if (!Number.isInteger(data.revision) || data.revision < 0) throw invalid();
    if (typeof data.invitationSuppressed !== 'boolean') throw invalid();
    if (!Number.isInteger(data.replays) || data.replays < 0) throw invalid();
    if (
      !Array.isArray(data.visitedStepIds) ||
      !data.visitedStepIds.every((id: unknown) => typeof id === 'string')
    )
      throw invalid();
    if (
      !Array.isArray(data.appliedEvents) ||
      !data.appliedEvents.every(
        (entry: unknown) =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as any).eventId === 'string' &&
          typeof (entry as any).fingerprint === 'string',
      )
    )
      throw invalid();
    if (
      !Array.isArray(data.terminalHistory) ||
      !data.terminalHistory.every(
        (entry: unknown) =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          TOUR_STATES.includes((entry as any).state) &&
          isIsoOrNull((entry as any).at),
      )
    )
      throw invalid();
    if (data.lastStepId !== null && typeof data.lastStepId !== 'string')
      throw invalid();
    for (const field of [
      'startedAt',
      'updatedAt',
      'closedAt',
      'skippedAt',
      'completedAt',
    ])
      if (!isIsoOrNull(data[field])) throw invalid();
    return {
      schemaVersion: 1,
      accountId,
      releaseId,
      tourVersion,
      state: data.state as TourState,
      invitationSuppressed: data.invitationSuppressed as boolean,
      revision: data.revision as number,
      visitedStepIds: (data.visitedStepIds as string[]).slice(),
      lastStepId: (data.lastStepId as string) ?? null,
      replays: data.replays as number,
      terminalHistory: (data.terminalHistory as any[]).map((entry) => ({
        state: entry.state as TourState,
        at: isoOrNull(entry.at),
      })),
      appliedEvents: (data.appliedEvents as any[]).map((entry) => ({
        eventId: entry.eventId as string,
        fingerprint: entry.fingerprint as string,
      })),
      startedAt: isoOrNull(data.startedAt),
      updatedAt: isoOrNull(data.updatedAt),
      closedAt: isoOrNull(data.closedAt),
      skippedAt: isoOrNull(data.skippedAt),
      completedAt: isoOrNull(data.completedAt),
    };
  }

  async get(
    accountId: string,
    releaseId: string,
    tourVersion: string,
  ): Promise<TourProgressRecord> {
    const snapshot = await this.doc(accountId, releaseId, tourVersion).get();
    if (!snapshot.exists)
      return emptyProgress(accountId, releaseId, tourVersion);
    return this.hydrate(snapshot.data(), accountId, releaseId, tourVersion);
  }

  /**
   * Lápida primero, duplicado después, CAS al final: todo en la misma
   * transacción, así una baja de cuenta concurrente no deja restos y un
   * reintento no duplica ni pisa una escritura ajena.
   */
  async apply(
    accountId: string,
    releaseId: string,
    tourVersion: string,
    command: TourProgressCommand,
    now: Date = new Date(),
  ): Promise<TourProgressOutcome> {
    const ref = this.doc(accountId, releaseId, tourVersion);
    const tombstone = this.db.collection(DELETED_ACCOUNTS).doc(accountId);
    return this.db.runTransaction(async (tx) => {
      const [deleted, snapshot] = await Promise.all([
        tx.get(tombstone),
        tx.get(ref),
      ]);
      if (deleted.exists) throw new UnauthorizedException();
      const current = snapshot.exists
        ? this.hydrate(snapshot.data(), accountId, releaseId, tourVersion)
        : emptyProgress(accountId, releaseId, tourVersion);
      const outcome = applyTourAction(current, command, now);
      if (outcome.kind !== 'applied') return outcome;
      tx.set(ref, outcome.record as unknown as Record<string, unknown>);
      return outcome;
    });
  }
}
