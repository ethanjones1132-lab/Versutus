import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { createGate } from '../core/server.mjs';

/**
 * `listen()` registered its `'error'` listener inside the promise it rejects, and
 * never removed it. Once the Gate is serving that promise is settled, so any
 * later error on the HTTP server — EMFILE/ENFILE from `accept()` under handle
 * pressure, a re-listen onto a taken port — called a spent `reject` and nothing
 * else. Node raises no uncaught exception once a listener exists, and the
 * process guards only watch rejections and exceptions, so the Gate kept running
 * while refusing connections with nothing in the operator's log.
 *
 * The error is raised on the real listener a real Gate built
 * (`gate.httpServer`): a listening server has no other way to produce an
 * `'error'` event from outside, and accept-side EMFILE/ENFILE cannot be forced
 * from a test at all.
 */

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-listen-errors-'));
  roots.push(root);
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  return createGate({ root, port: 0, gateHome: join(root, '.gate-home') });
}

test('an error on a listening Gate is logged, not swallowed by a spent reject', async () => {
  const gate = await makeGate();
  const logged = [];
  const realError = console.error;
  // Captured the way the operator's console would render it, code included.
  console.error = (...args) => { logged.push(inspect(args, { depth: 3 })); };
  try {
    assert.equal(gate.httpServer.listening, true, 'the Gate is serving before anything goes wrong');
    gate.httpServer.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      logged.some((line) => line.includes('HTTP server error') && line.includes('EMFILE')),
      `the operator's log must say the Gate could not serve: ${JSON.stringify(logged)}`,
    );

    // And the Gate is still serving — the log is a fact, not an exit.
    const health = await fetch(`http://127.0.0.1:${gate.port}/health`);
    assert.equal(health.status, 200);
  } finally {
    console.error = realError;
    await gate.close();
  }
});