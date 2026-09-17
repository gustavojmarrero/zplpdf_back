import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const job = process.argv[2];
if (!['A08', 'A09', 'A10', 'A11'].includes(job))
  throw new Error('Unknown COE job');
const root = resolve('.local/growth');
await mkdir(root, { recursive: true });
const json = (path) =>
  readFile(path, 'utf8')
    .then(JSON.parse)
    .catch(() => null);
const now = Date.now(),
  day = 86400000,
  offset = 6 * 3600000;
const local = new Date(now - offset);
let end;
let start;
if (job === 'A10') {
  end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + offset;
  start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) + offset;
} else {
  end =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() - ((local.getUTCDay() + 6) % 7),
    ) + offset;
  start = end - 7 * day;
}
const periodStartUtc = new Date(start).toISOString(),
  periodEndUtc = new Date(end).toISOString();
const runId = `${job}_${start}_${end}_coe-v1`;
const outputDirectory = resolve(root, 'reports', runId);
let status = 'ready',
  reason = null;
let manifest = null;
if (job === 'A11') {
  const last = await json(resolve(root, 'market-state.json'));
  if (
    last?.lastSuccessfulAt &&
    Number.isFinite(Date.parse(last.lastSuccessfulAt)) &&
    now - Date.parse(last.lastSuccessfulAt) < 14 * day
  )
    status = 'skipped_not_due';
} else {
  manifest = await json(resolve(root, 'current-snapshot-manifest.json'));
  if (!manifest) status = 'missing_dependency';
  else {
    const body =
      typeof manifest.snapshotPath === 'string'
        ? await readFile(manifest.snapshotPath).catch(() => null)
        : null;
    const watermark = Date.parse(manifest.sourceWatermark);
    let snapshot = null;
    try {
      snapshot = body ? JSON.parse(body.toString()) : null;
    } catch {
      /* Rejected as invalid evidence below. */
    }
    if (
      !body ||
      !snapshot ||
      createHash('sha256').update(body).digest('hex') !== manifest.checksum
    ) {
      status = 'invalid_evidence';
      reason = 'checksum_mismatch';
    } else if (
      snapshot.schemaVersion !== 2 ||
      snapshot.calculationVersion !== 'growth-v2'
    ) {
      status = 'invalid_evidence';
      reason = 'unsupported_snapshot_contract';
    } else if (
      manifest.status !== 'observed' ||
      !Number.isFinite(watermark) ||
      watermark > now ||
      now - watermark > 36 * 3600000
    ) {
      status = 'insufficient_data';
      reason = 'snapshot_not_fresh_observed';
    } else if (snapshot.billingCoverage !== 'complete') {
      status = 'insufficient_data';
      reason = 'billing_history_not_verified';
    }
  }
  if (status === 'ready' && job === 'A09') {
    const upstreamDirectory = resolve(
      root,
      'reports',
      `A08_${start}_${end}_coe-v1`,
    );
    const upstream = await json(resolve(upstreamDirectory, 'receipt.json'));
    if (
      upstream?.status !== 'succeeded' ||
      upstream.snapshotChecksum !== manifest.checksum
    ) {
      status = 'missing_dependency';
      reason = 'same_period_A08_receipt_required';
    } else {
      for (const name of ['coe_weekly.md', 'action_proposals.json']) {
        const expected = upstream.files?.find(
          (file) => file.name === name,
        )?.checksum;
        const body = await readFile(resolve(upstreamDirectory, name)).catch(
          () => null,
        );
        if (
          !expected ||
          !body ||
          createHash('sha256').update(body).digest('hex') !== expected
        ) {
          status = 'invalid_evidence';
          reason = 'upstream_artifact_changed';
        }
      }
    }
  }
}
const prior = await json(resolve(outputDirectory, 'receipt.json'));
if (prior?.status === 'succeeded') status = 'already_completed';
await mkdir(outputDirectory, { recursive: true });
const context = {
  job,
  runId,
  status,
  reason,
  periodStartUtc,
  periodEndUtc,
  timezone: 'America/Merida',
  calculationVersion: 'coe-v1',
  snapshotChecksum: manifest?.checksum ?? null,
  snapshotPath: manifest?.snapshotPath ?? null,
  snapshotManifestPath: manifest
    ? resolve(root, 'current-snapshot-manifest.json')
    : null,
  outputDirectory,
  checkedAt: new Date().toISOString(),
};
await writeFile(
  resolve(root, `${job}-precheck.json`),
  JSON.stringify(context, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(context));
process.exitCode = status === 'ready' ? 0 : 2;
