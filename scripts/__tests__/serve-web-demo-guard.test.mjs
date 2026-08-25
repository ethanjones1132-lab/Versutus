// Pin for the serve-web-demo traversal guard (../serve-web-demo.mjs).
//
// The demo server is the pilot buyer's first ten minutes: `npm run serve:web`
// must serve ONLY the export directory. The guard used to be a bare
// `resolved.startsWith(ROOT)`, so any SIBLING directory whose name merely
// extends the served directory's name (`dist` vs `dist-evil`) passed the
// prefix check and its files were reachable over HTTP. The guard now requires
// `ROOT + path.sep`. These tests spawn the real script and prove both sides:
// sibling escapes are 404 while ordinary in-root serving still works.
//
// Lives under scripts/__tests__ (not gate/__tests__) because it pins a repo
// script; it runs through the same `npm run test:gate` node --test leg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await get(port, '/');
      if (res.status !== undefined) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('demo server never answered');
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function withDemoServer(run) {
  // Fixture mirrors the reported shape: served dir `demo-dist`, sibling
  // `demo-dist-evil` — the sibling's full path STARTS WITH the served dir's
  // path, which is exactly what the bare-prefix guard let through.
  const base = await mkdtemp(join(tmpdir(), 'vs-demo-'));
  const servedDir = join(base, 'demo-dist');
  const siblingDir = join(base, 'demo-dist-evil');
  await mkdir(servedDir);
  await mkdir(siblingDir);
  await writeFile(join(servedDir, 'index.html'), '<h1>demo-home</h1>');
  await writeFile(join(siblingDir, 'secret.txt'), 'sibling-secret');

  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      join(SCRIPTS_DIR, '..', 'serve-web-demo.mjs'),
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--dir',
      servedDir,
    ],
    { cwd: join(SCRIPTS_DIR, '..', '..'), stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(port);
    await run(port, siblingDir);
  } catch (error) {
    if (stderr) console.error('demo server stderr:', stderr);
    throw error;
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  }
}

test('serves the export directory itself', async () => {
  await withDemoServer(async (port) => {
    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('demo-home'));
    const direct = await get(port, '/index.html');
    assert.equal(direct.status, 200);
  });
});

test('404s dot-dot escapes into a sibling directory', async () => {
  await withDemoServer(async (port, siblingDir) => {
    const escape = `/../${siblingDir.split(/[\\/]/).pop()}/secret.txt`;
    const raw = await get(port, escape);
    assert.equal(raw.status, 404);
    assert.ok(!raw.body.includes('sibling-secret'));
  });
});

test('404s percent-encoded dot-dot escapes into a sibling directory', async () => {
  await withDemoServer(async (port, siblingDir) => {
    const escape = `/%2e%2e/${siblingDir.split(/[\\/]/).pop()}/secret.txt`;
    const encoded = await get(port, escape);
    assert.equal(encoded.status, 404);
    assert.ok(!encoded.body.includes('sibling-secret'));
  });
});
