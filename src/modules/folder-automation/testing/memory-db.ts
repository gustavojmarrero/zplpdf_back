import { FieldValue } from '@google-cloud/firestore';
export class MemoryDb {
  rows = new Map<string, any>();
  beforeCommit?: () => void;
  private tail = Promise.resolve();
  doc(path: string) {
    return this.ref(path);
  }
  ref(path: string): any {
    return {
      path,
      id: path.split('/').pop(),
      get: async () => this.snap(path),
      update: async (value: any) => this.apply(path, value, true),
    };
  }
  snap(path: string): any {
    const data = this.rows.get(path);
    return {
      ref: this.ref(path),
      id: path.split('/').pop(),
      exists: !!data,
      data: () => data,
      get: (key: string) => data?.[key],
    };
  }
  collection(name: string): any {
    const query = (
      filters: Array<[string, string, any]> = [],
      order?: [string, string],
      limit = Infinity,
    ): any => ({
      where: (field: string, op: string, value: any) =>
        query([...filters, [field, op, value]], order, limit),
      orderBy: (key: string, direction = 'asc') =>
        query(filters, [key, direction], limit),
      limit: (count: number) => query(filters, order, count),
      get: async () => {
        const docs = [...this.rows.entries()]
          .filter(
            ([path, row]) =>
              path.startsWith(`${name}/`) &&
              filters.every(([field, op, value]) =>
                op === '=='
                  ? row[field] === value
                  : row[field] !== undefined && row[field] <= value,
              ),
          )
          .sort((a, b) => {
            if (!order) return a[0].localeCompare(b[0]);
            const [field, direction] = order;
            const comparison =
              a[1][field] < b[1][field]
                ? -1
                : a[1][field] > b[1][field]
                  ? 1
                  : 0;
            return direction === 'desc' ? -comparison : comparison;
          })
          .slice(0, limit)
          .map(([path]) => this.snap(path));
        return { docs, size: docs.length };
      },
    });
    return { doc: (id: string) => this.ref(`${name}/${id}`), ...query() };
  }
  apply(path: string, data: any, merge = false) {
    const row = merge ? { ...this.rows.get(path) } : {};
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof FieldValue && value.isEqual(FieldValue.delete()))
        delete row[key];
      else if (
        value instanceof FieldValue &&
        typeof (value as any).operand === 'number'
      )
        row[key] = (row[key] ?? 0) + (value as any).operand;
      else row[key] = value;
    }
    this.rows.set(path, row);
  }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release: () => void;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    const writes: Array<() => void> = [];
    try {
      const result = await fn({
        get: async (ref: any) => {
          if (writes.length) throw new Error('read after write');
          return this.snap(ref.path);
        },
        create: (ref: any, v: any) =>
          writes.push(() => this.apply(ref.path, v)),
        update: (ref: any, v: any) =>
          writes.push(() => this.apply(ref.path, v, true)),
        set: (ref: any, v: any, opts: any) =>
          writes.push(() => this.apply(ref.path, v, opts?.merge)),
      });
      this.beforeCommit?.();
      writes.forEach((write) => write());
      return result;
    } finally {
      release();
    }
  }
}
