import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const script = resolve('scripts/growth/export-snapshot.mjs');
test('snapshot export authenticates, rejects unsafe output and writes a verifiable private artifact', async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), 'growth-export-'));
  let snapshot = { schemaVersion: 2, features: [], status: 'observed' };
  let redirect = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-test-token');
    assert.equal(req.url, '/api/admin/growth/snapshot');
    if (redirect) {
      res.writeHead(302, { Location: '/unexpected' });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(snapshot));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script], {
        cwd,
        env: {
          PATH: process.env.PATH,
          GROWTH_BACKEND_URL: `http://127.0.0.1:${server.address().port}`,
          GROWTH_ADMIN_TOKEN: 'synthetic-test-token',
        },
      });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      child.on('close', (code) => resolve({ code, output }));
    });
  try {
    const success = await run();
    assert.equal(success.code, 0, success.output);
    const manifestPath = resolve(
      cwd,
      '.local/growth/current-snapshot-manifest.json',
    );
    const original = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(original);
    const body = await readFile(manifest.snapshotPath, 'utf8');
    assert.equal(
      createHash('sha256').update(body).digest('hex'),
      manifest.checksum,
    );
    assert.equal((await stat(manifest.snapshotPath)).mode & 0o777, 0o600);
    for (const unsafe of [
      { accountId: 'private-uid' },
      { convertedAccounts: ['private-uid'] },
      { source: 'person@example.com' },
      { source: 'rk_live_fake' },
    ]) {
      snapshot = { schemaVersion: 2, features: [], nested: unsafe };
      const result = await run();
      assert.notEqual(result.code, 0);
      assert.doesNotMatch(
        result.output,
        /synthetic-test-token|private-uid|person@example.com|rk_live_fake/,
      );
      assert.equal(await readFile(manifestPath, 'utf8'), original);
    }
    redirect = true;
    assert.notEqual((await run()).code, 0);
    assert.equal(await readFile(manifestPath, 'utf8'), original);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
});
