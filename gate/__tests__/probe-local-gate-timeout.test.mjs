import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { probeLocalGate } from '../core/service/diagnostics.mjs';

/**
 * A local listener whose behaviour the test dictates. `hang` accepts the
 * connection and never answers headers — the shape of a half-dead process still
 * holding the port, which is what hung `gate service stop`.
 */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/.well-known/gateway.json` };
}

const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

const settle = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`probe still pending after ${ms}ms`)), ms).unref?.()),
]);

test('a listener that never answers headers times out instead of hanging', async () => {
  const { server, url } = await listen(() => { /* accept, answer nothing */ });
  try {
    const started = Date.now();
    const probe = await settle(probeLocalGate(url, undefined, { timeoutMs: 150 }), 3000);
    assert.equal(probe.reachable, false);
    assert.ok(probe.detail.length > 0, 'the timeout is reported like any other failure');
    assert.ok(Date.now() - started < 3000, 'it gave up on its own, not on the test');
  } finally {
    await close(server);
  }
});

test('the default fetch is bounded, so no caller can hang on a stuck listener', async () => {
  // What `service stop` relies on: its two probes take the default path, and
  // the signal is what ends them. Asserted on the options the real fetch is
  // given rather than by waiting out the production 5 s default.
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url, options) => {
    seen.push(options);
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    });
  };
  try {
    // Left unawaited on purpose: what aborting a stuck probe reports is proven
  // above with a small injected timeout, and the 5 s production default would
  // only add 5 s to the suite. probeLocalGate catches the abort either way.
    probeLocalGate('http://127.0.0.1:8760/.well-known/gateway.json');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, 1);
    assert.ok(seen[0].signal instanceof AbortSignal, 'the default fetch carries a deadline');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a manifest that answers is still reachable, and a 500 is not', async () => {
  const ok = await listen((_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  try {
    const probe = await probeLocalGate(ok.url, undefined, { timeoutMs: 2000 });
    assert.deepEqual(probe, { reachable: true, detail: 'manifest answered 200' });
  } finally {
    await close(ok.server);
  }

  const broken = await listen((_, response) => {
    response.writeHead(500);
    response.end();
  });
  try {
    const probe = await probeLocalGate(broken.url, undefined, { timeoutMs: 2000 });
    assert.equal(probe.reachable, false);
    assert.match(probe.detail, /500/);
  } finally {
    await close(broken.server);
  }
});

test('an injected fetch is used exactly as given', async () => {
  const calls = [];
  const reachable = await probeLocalGate('http://127.0.0.1:1/x', (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true, status: 204 });
  });
  assert.deepEqual(reachable, { reachable: true, detail: 'manifest answered 204' });
  assert.deepEqual(calls, ['http://127.0.0.1:1/x'], 'the caller fetch owns the request');
});