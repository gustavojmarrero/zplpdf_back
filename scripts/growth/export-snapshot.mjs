import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const base = process.env.GROWTH_BACKEND_URL;
const token = process.env.GROWTH_ADMIN_TOKEN;
if (!base || !token)
  throw new Error(
    'missing_dependency: GROWTH_BACKEND_URL and GROWTH_ADMIN_TOKEN are required',
  );
const url = new URL('/api/admin/growth/snapshot', base);
if (
  url.username ||
  url.password ||
  (url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1'].includes(url.hostname))
)
  throw new Error('Invalid backend URL');
const response = await fetch(url, {
  headers: {
    Authorization: `Bearer ${token}`,
    ...(process.env.GROWTH_ADMIN_EMAIL
      ? { 'X-Admin-Email': process.env.GROWTH_ADMIN_EMAIL }
      : {}),
  },
  redirect: 'error',
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
const snapshot = await response.json();
if (snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.features))
  throw new Error('Unsupported snapshot schema');
const body = JSON.stringify(snapshot, null, 2);
if (
  /"(?:email|userEmail|accountId|accountIds|userId|userIds|convertedAccounts|customerId|clientId|zpl|pdf|token|secret|signedUrl)"\s*:/i.test(
    body,
  )
)
  throw new Error('Snapshot contains a forbidden field');
if (
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(body) ||
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/.test(body)
)
  throw new Error('Snapshot contains personal data or credentials');
const checksum = createHash('sha256').update(body).digest('hex');
const directory = resolve(
  process.argv[2] ?? '.local/growth/snapshots',
  checksum,
);
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'snapshot.json'), body, { mode: 0o600 });
const manifest = {
  schemaVersion: 1,
  snapshotId: checksum,
  checksum,
  status: snapshot.status,
  sourceWatermark: snapshot.sourceWatermark ?? null,
  window: snapshot.window ?? null,
  calculationVersion: snapshot.calculationVersion ?? null,
  createdAt: new Date().toISOString(),
  snapshotPath: resolve(directory, 'snapshot.json'),
};
await writeFile(
  resolve(directory, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    manifestPath: resolve(directory, 'manifest.json'),
    status: manifest.status,
  }),
);

const current = resolve('.local/growth/current-snapshot-manifest.json');
await mkdir(resolve('.local/growth'), { recursive: true });
await writeFile(current + '.tmp', JSON.stringify(manifest, null, 2), {
  mode: 0o600,
});
await rename(current + '.tmp', current);
