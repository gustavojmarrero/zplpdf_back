import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { TourProgressRepository } from '../src/modules/product-updates/tour-progress.repository.js';
import {
  PRODUCT_TOUR_PROGRESS_COLLECTION,
  progressDocId,
} from '../src/modules/product-updates/product-updates.types.js';

/**
 * BE11 contra el emulador REAL de Firestore.
 *
 * Lo que un doble no puede demostrar: que dos clientes distintos que mandan la
 * misma acción con el mismo `expectedRevision` no la aplican los dos, que el
 * reintento de un `eventId` ya aplicado confirma en vez de duplicar, y que la
 * lápida de baja de cuenta gana la carrera dentro de la misma transacción.
 */
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085')
  throw new Error(
    'This suite requires the isolated local Firestore emulator at 127.0.0.1:8085',
  );

const projectId = 'demo-zplpdf-growth';
const db = new Firestore({ projectId, ignoreUndefinedProperties: true });
/** Segundo cliente: la concurrencia tiene que cruzar la conexión. */
const otherClient = new Firestore({
  projectId,
  ignoreUndefinedProperties: true,
});

const suite = randomUUID().slice(0, 8);
const releaseId = 'growth-2026-09';
const tourVersion = '1';
const repository = new TourProgressRepository(db as any);
const otherRepository = new TourProgressRepository(otherClient as any);
const account = (name: string) => `synthetic-tour-${suite}-${name}`;
const docPath = (accountId: string) =>
  `${PRODUCT_TOUR_PROGRESS_COLLECTION}/${progressDocId(
    accountId,
    releaseId,
    tourVersion,
  )}`;

const command = (
  action: 'start' | 'view_step' | 'close' | 'skip' | 'complete' | 'replay',
  expectedRevision: number,
  stepId?: string,
) => ({ eventId: randomUUID(), expectedRevision, action, stepId });

afterAll(async () => {
  const stale = await db
    .collection(PRODUCT_TOUR_PROGRESS_COLLECTION)
    .where('accountId', '>=', `synthetic-tour-${suite}`)
    .where('accountId', '<', `synthetic-tour-${suite}￿`)
    .get();
  await Promise.all(stale.docs.map((doc) => doc.ref.delete()));
  await Promise.all(
    ['deleted'].map((name) =>
      db.collection('deleted_accounts').doc(account(name)).delete(),
    ),
  );
  await Promise.all([db.terminate(), otherClient.terminate()]);
});

describe('tour progress against the real emulator', () => {
  it('applies one of two concurrent writers and makes the loser resync', async () => {
    const accountId = account('cas');
    const first = await repository.apply(accountId, releaseId, tourVersion, {
      ...command('start', 0),
    });
    expect(first.kind).toBe('applied');

    const [a, b] = await Promise.all([
      repository.apply(accountId, releaseId, tourVersion, {
        ...command('view_step', 1, 'packing_intro'),
      }),
      otherRepository.apply(accountId, releaseId, tourVersion, {
        ...command('complete', 1),
      }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['applied', 'conflict']);
    const stored = (await db.doc(docPath(accountId)).get()).data();
    expect(stored.revision).toBe(2);
    // El perdedor devuelve la revisión real para que el cliente resincronice.
    const loser = a.kind === 'conflict' ? a : b;
    expect(loser.record.revision).toBeLessThanOrEqual(stored.revision);
  });

  it('confirms a retried event without applying it twice', async () => {
    const accountId = account('retry');
    const retried = command('view_step', 0, 'templates_intro');
    const first = await repository.apply(
      accountId,
      releaseId,
      tourVersion,
      retried,
    );
    expect(first.kind).toBe('applied');
    // Mismo eventId desde otra conexión y con la revisión vieja del cliente.
    const retry = await otherRepository.apply(
      accountId,
      releaseId,
      tourVersion,
      retried,
    );
    expect(retry.kind).toBe('duplicate');
    const stored = (await db.doc(docPath(accountId)).get()).data();
    expect(stored.revision).toBe(1);
    expect(stored.visitedStepIds).toEqual(['templates_intro']);
    expect(stored.appliedEvents).toEqual([
      {
        eventId: retried.eventId,
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);

    // Mismo id con otro cuerpo: reutilización, no reintento.
    const reused = await otherRepository.apply(
      accountId,
      releaseId,
      tourVersion,
      {
        ...retried,
        action: 'skip',
        stepId: undefined,
      },
    );
    expect(reused.kind).toBe('event_conflict');
    const untouched = (await db.doc(docPath(accountId)).get()).data();
    expect(untouched.revision).toBe(1);
    expect(untouched.state).toBe('started');
    expect(untouched.invitationSuppressed).toBe(false);
  });

  it('keeps terminal history across a real replay and never loses visited steps', async () => {
    const accountId = account('replay');
    await repository.apply(accountId, releaseId, tourVersion, {
      ...command('view_step', 0, 'packing_intro'),
    });
    await repository.apply(accountId, releaseId, tourVersion, {
      ...command('complete', 1),
    });
    await repository.apply(accountId, releaseId, tourVersion, {
      ...command('replay', 2),
    });
    expect(
      (await db.doc(docPath(accountId)).get()).get('invitationSuppressed'),
    ).toBe(true);
    const record = await repository.get(accountId, releaseId, tourVersion);
    expect(record.state).toBe('started');
    // La supresión de invitación sobrevive a repetir, no solo al estado.
    expect(record.invitationSuppressed).toBe(true);
    expect(record.replays).toBe(1);
    expect(record.terminalHistory.map((entry) => entry.state)).toEqual([
      'completed',
    ]);
    expect(record.completedAt).not.toBeNull();
    expect(record.visitedStepIds).toEqual(['packing_intro']);
  });

  it('refuses to write progress once the account is marked for deletion', async () => {
    const accountId = account('deleted');
    await db
      .collection('deleted_accounts')
      .doc(accountId)
      .set({ deletedAt: new Date().toISOString() });
    await expect(
      repository.apply(accountId, releaseId, tourVersion, {
        ...command('start', 0),
      }),
    ).rejects.toMatchObject({ status: 401 });
    const stored = await db.doc(docPath(accountId)).get();
    expect(stored.exists).toBe(false);
  });

  it('isolates accounts sharing the same release and version', async () => {
    const mine = account('iso-a');
    const theirs = account('iso-b');
    await repository.apply(mine, releaseId, tourVersion, {
      ...command('skip', 0),
    });
    const other = await repository.get(theirs, releaseId, tourVersion);
    expect(other.state).toBe('pending');
    expect(other.revision).toBe(0);
    expect(other.invitationSuppressed).toBe(false);
    expect((await db.doc(docPath(theirs)).get()).exists).toBe(false);
    // Ids por hash del triplete: ni se parecen ni revelan la cuenta.
    expect(docPath(mine)).not.toContain(mine);
    expect(docPath(mine)).not.toBe(docPath(theirs));
  });
});
