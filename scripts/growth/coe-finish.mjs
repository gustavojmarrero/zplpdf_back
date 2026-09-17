import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const job = process.argv[2];
const required = {
  A08: ['coe_weekly.md', 'action_proposals.json'],
  A09: ['coe_review.md'],
  A10: ['coe_monthly.md', 'decision_proposals.json'],
  A11: ['market_signals.md'],
};
if (!required[job]) throw new Error('Unknown COE job');
const root = resolve('.local/growth');
const context = JSON.parse(
  await readFile(resolve(root, `${job}-precheck.json`), 'utf8'),
);
const checkedAt = Date.parse(context.checkedAt);
if (
  context.status !== 'ready' ||
  context.job !== job ||
  !Number.isFinite(checkedAt) ||
  checkedAt > Date.now() ||
  Date.now() - checkedAt > 2 * 3600000
)
  throw new Error('Fresh successful precheck required');
if (job !== 'A11') {
  const snapshot =
    typeof context.snapshotPath === 'string'
      ? await readFile(context.snapshotPath).catch(() => null)
      : null;
  if (
    !snapshot ||
    createHash('sha256').update(snapshot).digest('hex') !==
      context.snapshotChecksum
  )
    throw new Error('Snapshot changed after precheck');
}
const files = [];
for (const name of required[job]) {
  const body = await readFile(resolve(context.outputDirectory, name), 'utf8');
  if (!body.trim() || body.length > 1000000)
    throw new Error('Invalid report size');
  if (name.endsWith('.json')) JSON.parse(body);
  if (
    /\b(?:sk|rk)_(?:live|test)_|zp_(?:live|test)_|X-Goog-Signature=|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
      body,
    )
  )
    throw new Error('Sensitive content in report');
  files.push({
    name,
    checksum: createHash('sha256').update(body).digest('hex'),
  });
}
const receipt = {
  ...context,
  status: 'succeeded',
  completedAt: new Date().toISOString(),
  files,
  verification: 'artifact_integrity_only_not_human_approval',
};
await writeFile(
  resolve(context.outputDirectory, 'receipt.json'),
  JSON.stringify(receipt, null, 2),
  { mode: 0o600 },
);
if (job === 'A11') {
  const path = resolve(root, 'market-state.json');
  await writeFile(
    path + '.tmp',
    JSON.stringify({
      lastSuccessfulAt: receipt.completedAt,
      runId: context.runId,
    }),
    { mode: 0o600 },
  );
  await rename(path + '.tmp', path);
}
console.log(JSON.stringify({ runId: context.runId, status: receipt.status }));
