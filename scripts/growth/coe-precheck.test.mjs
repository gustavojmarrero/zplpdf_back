import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const precheck = resolve('scripts/growth/coe-precheck.mjs');
const finish = resolve('scripts/growth/coe-finish.mjs');
const run = (cwd, path, job) =>
  spawnSync(process.execPath, [path, job], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
test('COE rejects missing/tampered evidence and binds independent review to completed same-period report', async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), 'zpl-coe-test-'));
  try {
    assert.equal(run(cwd, precheck, 'A08').status, 2);
    const root = resolve(cwd, '.local/growth');
    await mkdir(root, { recursive: true });
    const snapshot = JSON.stringify({
      schemaVersion: 2,
      calculationVersion: 'growth-v2',
      features: [],
      billingCoverage: 'complete',
    });
    const snapshotPath = resolve(root, 'synthetic.json');
    await writeFile(snapshotPath, snapshot);
    const manifest = {
      status: 'observed',
      sourceWatermark: new Date().toISOString(),
      snapshotPath,
      checksum: createHash('sha256').update(snapshot).digest('hex'),
    };
    await writeFile(
      resolve(root, 'current-snapshot-manifest.json'),
      JSON.stringify(manifest),
    );
    const ready = run(cwd, precheck, 'A08');
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(run(cwd, precheck, 'A09').status, 2);
    const context = JSON.parse(ready.stdout);
    await writeFile(
      resolve(context.outputDirectory, 'coe_weekly.md'),
      'Synthetic test report. No product claim.',
    );
    await writeFile(
      resolve(context.outputDirectory, 'action_proposals.json'),
      '[]',
    );
    assert.equal(run(cwd, finish, 'A08').status, 0);
    assert.equal(run(cwd, precheck, 'A09').status, 0);
    assert.equal(
      JSON.parse(run(cwd, precheck, 'A08').stdout).status,
      'already_completed',
    );
    const reportPath = resolve(context.outputDirectory, 'coe_weekly.md');
    const report = await readFile(reportPath, 'utf8');
    await writeFile(reportPath, 'Modified after receipt');
    assert.equal(
      JSON.parse(run(cwd, precheck, 'A09').stdout).reason,
      'upstream_artifact_changed',
    );
    await writeFile(reportPath, report);
    const monthly = JSON.parse(run(cwd, precheck, 'A10').stdout);
    await writeFile(
      resolve(monthly.outputDirectory, 'coe_monthly.md'),
      'Synthetic monthly report',
    );
    await writeFile(
      resolve(monthly.outputDirectory, 'decision_proposals.json'),
      '[]',
    );
    await writeFile(snapshotPath, 'tampered');
    assert.notEqual(run(cwd, finish, 'A10').status, 0);
    assert.equal(run(cwd, precheck, 'A09').status, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test('market cadence advances only after real artifact completion', async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), 'zpl-market-test-'));
  try {
    const context = JSON.parse(run(cwd, precheck, 'A11').stdout);
    assert.equal(run(cwd, finish, 'A11').status, 1);
    await writeFile(
      resolve(context.outputDirectory, 'market_signals.md'),
      'Synthetic market fixture.',
    );
    assert.equal(run(cwd, finish, 'A11').status, 0);
    const state = JSON.parse(
      await readFile(resolve(cwd, '.local/growth/market-state.json'), 'utf8'),
    );
    assert.ok(state.lastSuccessfulAt);
    assert.equal(run(cwd, precheck, 'A11').status, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
