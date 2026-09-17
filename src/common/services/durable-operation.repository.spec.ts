import { FieldValue, Firestore } from '@google-cloud/firestore';
import {
  DurableOperationRepository,
  DurableOperationInput,
} from './durable-operation.repository.js';
class Memory {
  rows = new Map<string, any>();
  tail = Promise.resolve();
  collection(name: string) {
    return { doc: (id: string) => `${name}/${id}` };
  }
  async runTransaction(fn: any) {
    const previous = this.tail;
    let release: () => void;
    this.tail = new Promise((r) => {
      release = r;
    });
    await previous;
    const writes: Array<() => void> = [];
    const merge = (id: string, data: any) => () => {
      const row = { ...this.rows.get(id) };
      for (const [k, v] of Object.entries(data)) {
        const increment = [-1, 1, 2].find(
          (n) => v instanceof FieldValue && v.isEqual(FieldValue.increment(n)),
        );
        row[k] = increment === undefined ? v : (row[k] ?? 0) + increment;
      }
      this.rows.set(id, row);
    };
    try {
      const value = await fn({
        get: async (id: string) => {
          if (writes.length) throw new Error('read after write');
          return { exists: this.rows.has(id), data: () => this.rows.get(id) };
        },
        set: (id: string, data: any) => writes.push(merge(id, data)),
        update: (id: string, data: any) => writes.push(merge(id, data)),
      });
      writes.forEach((w) => w());
      return value;
    } finally {
      release();
    }
  }
}
const input: DurableOperationInput = {
  operationId: 'operation-a',
  userId: 'user-a',
  fingerprint: 'hash-a',
  period: {
    periodId: 'period-a',
    periodStart: new Date('2026-09-01'),
    periodEnd: new Date('2026-10-01'),
  },
  maxPdfs: 1,
  labelCount: 2,
  labelSize: '4x6',
  outputFormat: 'pdf',
  sourcePath: 'private/source.zpl',
};
describe('durable conversion accounting', () => {
  let db: Memory;
  let repo: DurableOperationRepository;
  beforeEach(() => {
    db = new Memory();
    db.rows.set('users/user-a', {});
    repo = new DurableOperationRepository(db as unknown as Firestore);
  });
  it('admits only one concurrent operation at a one-PDF limit', async () => {
    const results = await Promise.allSettled([
      repo.claim(input),
      repo.claim({ ...input, operationId: 'operation-b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.rows.get('usage/period-a').reservedPdfCount).toBe(1);
  });
  it('finishes quota/history atomically and a replay consumes nothing', async () => {
    const claim = await repo.claim(input);
    await repo.finish(input.operationId, claim.token, {
      url: 'signed',
      filename: 'labels.pdf',
      storagePath: 'private/output.pdf',
    });
    expect(db.rows.get('usage/period-a')).toMatchObject({
      pdfCount: 1,
      labelCount: 2,
      reservedPdfCount: 0,
    });
    expect((await repo.claim(input)).completed).toBe(true);
    expect(
      [...db.rows.keys()].filter((k) => k.startsWith('conversion_history/')),
    ).toHaveLength(1);
  });
  it('recovers expired leases without reserving twice and fences stale completion', async () => {
    const first = await repo.claim(input);
    db.rows.get('durable_operations/operation-a').leaseUntil = 0;
    const second = await repo.claim(input);
    expect(db.rows.get('usage/period-a').reservedPdfCount).toBe(1);
    await expect(
      repo.finish(input.operationId, first.token, {
        url: 'signed',
        filename: 'labels.pdf',
        storagePath: 'private/output.pdf',
      }),
    ).rejects.toThrow('OPERATION_LEASE_LOST');
    await repo.fail(input.operationId, first.token);
    expect(db.rows.get('usage/period-a').reservedPdfCount).toBe(1);
    await repo.fail(input.operationId, second.token);
    expect(db.rows.get('usage/period-a').reservedPdfCount).toBe(0);
    await repo.fail(input.operationId, second.token);
    expect(db.rows.get('usage/period-a').reservedPdfCount).toBe(0);
  });
  it('does not write when deletion won the transaction or the payload changes', async () => {
    await repo.claim(input);
    await expect(
      repo.claim({ ...input, fingerprint: 'different' }),
    ).rejects.toThrow('OPERATION_PAYLOAD_CONFLICT');
    db.rows.set('deleted_accounts/user-a', {});
    await expect(repo.claim(input)).rejects.toThrow('Account unavailable');
  });
});
