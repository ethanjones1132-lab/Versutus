import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';
import { ProviderService } from '../core/providers/service.mjs';

// Stop, or a network that drops, used to leave the vendor generating (and
// billing) a turn for an answer nobody would read, and a vendor that accepted
// the connection and then said nothing held the request for undici's default
// instead of being told it timed out.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

/**
 * An upstream the test controls: it can answer and finish, answer and keep
 * streaming, or take the request and stay silent forever. It reports whether
 * the Gate gave up on it — a response that was never finished and whose socket
 * died is exactly a cancelled upstream request.
 */
async function startUpstream({ answer, hold = false, holdForMs = 0, silentForMs = 0 } = {}) {
  const state = { requests: 0, abandoned: 0 };
  const server = createServer((req, res) => {
    state.requests += 1;
    req.resume();
    res.on('close', () => {
      if (!res.writableFinished) state.abandoned += 1;
    });
    if (silentForMs) {
      // Headers, then silence for a while: a reasoning model that has taken a
      // long time over its first token. The head has to be flushed now, not
      // with the body, or the vendor's stall would arrive at the Gate as one
      // late response instead of an open stream. The stream then ends normally,
      // so the test leaves nothing behind.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => { if (!res.writableEnded) res.end(); }, silentForMs).unref?.();
    } else if (answer) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(answer);
      // Head and first frame together, then a stream that stays open for
      // `holdForMs`: the wait that follows is on the body, not on the headers.
      if (holdForMs) setTimeout(() => { if (!res.writableEnded) res.end(); }, holdForMs).unref?.();
      else if (!hold) res.end();
    }
    // With no `answer`, the response is simply never written: a vendor that
    // has taken the request and gone quiet.
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { state, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

async function gateWithStubProvider(upstreamBaseUrl, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-provider-abort-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(
    join(root, 'registry', 'stub.json'),
    JSON.stringify({
      kind: 'provider',
      label: 'Stub',
      config: {
        flavor: 'openai',
        baseUrl: upstreamBaseUrl,
        apiKeyEnv: 'STUB_KEY',
        models: ['stub-1'],
        streaming: true,
      },
    }),
    'utf8',
  );
  process.env.STUB_KEY = 'fake-key-for-tests';
  const gate = await createGate({ root, port: 0, ...options });
  return { gate, root };
}

// A Gate that is still flushing its provider store can recreate a file while the
// tree is being removed, which is a lost temp dir, not a failed assertion.
const removeRoot = (root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });

const post = (gate, { stream = true, signal } = {}) => fetch(`http://127.0.0.1:${gate.port}/p/stub/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
  signal,
  body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }], stream }),
});

const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};

test('a client that stops mid-stream takes the upstream request with it', async () => {
  const upstream = await startUpstream({
    answer: `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
    // Still streaming when the phone leaves: a vendor whose stream was already
    // finished could not be shown to keep running.
    hold: true,
  });
  const { gate, root } = await gateWithStubProvider(upstream.baseUrl);
  try {
    const controller = new AbortController();
    const pending = post(gate, { signal: controller.signal });
    // Wait until the vendor has actually answered, so there is a live upstream
    // request to abandon.
    assert.ok(await until(() => upstream.state.requests === 1));
    controller.abort();
    await pending.catch(() => undefined);
    assert.ok(
      await until(() => upstream.state.abandoned === 1),
      'the upstream request must be cancelled, not left streaming for nothing',
    );
  } finally {
    await gate.close();
    upstream.close();
    await removeRoot(root);
  }
});

test('a client that stops a non-streaming turn takes the upstream request with it', async () => {
  const upstream = await startUpstream();
  const { gate, root } = await gateWithStubProvider(upstream.baseUrl);
  try {
    const controller = new AbortController();
    const pending = post(gate, { stream: false, signal: controller.signal });
    assert.ok(await until(() => upstream.state.requests === 1));
    controller.abort();
    await pending.catch(() => undefined);
    assert.ok(
      await until(() => upstream.state.abandoned === 1),
      'a non-streaming turn must be abandoned upstream too',
    );
  } finally {
    await gate.close();
    upstream.close();
    await removeRoot(root);
  }
});

test('a provider that never answers is a 504, not a request held open forever', async () => {
  const upstream = await startUpstream();
  const { gate, root } = await gateWithStubProvider(upstream.baseUrl, { upstreamHeadersTimeoutMs: 60 });
  try {
    const response = await post(gate);
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.error.code, 'upstream_timeout');
    assert.match(body.error.message, /header timeout/i);
  } finally {
    await gate.close();
    upstream.close();
    await removeRoot(root);
  }
});

test('the bound is on the headers: a slow stream is not cut off', async () => {
  // The Gate must not mistake a long answer for a dead vendor: the watchdog is
  // cleared the moment the response exists. The vendor's head and first frame go
  // out together and the stream then stays open past the bound below, so what is
  // under test is the head clearing the clock. The bound is seconds rather than
  // milliseconds because it also has to cover this machine reaching the socket at
  // all: at 60ms the test reported on how busy the box was, not on the Gate.
  const upstream = await startUpstream({
    answer: `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`,
    holdForMs: 4000,
  });
  const { gate, root } = await gateWithStubProvider(upstream.baseUrl, { upstreamHeadersTimeoutMs: 3000 });
  try {
    const response = await post(gate);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"content":"Hi"/);
    // The turn ran past the header bound, so it must also have been carried to
    // its terminal frame: a stream cut short at the bound would still hold the
    // content it had already relayed.
    assert.match(body, /data: \[DONE\]/);
    assert.equal(upstream.state.abandoned, 0);
  } finally {
    await gate.close();
    upstream.close();
    await removeRoot(root);
  }
});

test('a reasoning provider that says nothing yet is not a dead stream', async () => {
  // The response headers advertise a heartbeat, so a client is entitled to
  // treat a quiet stream as dead and reconnect. A model that spends a good while
  // thinking before its first token must not be cut off for that.
  const upstream = await startUpstream({ silentForMs: 1200 });
  const { gate, root } = await gateWithStubProvider(upstream.baseUrl, { keepaliveIntervalMs: 10 });
  try {
    const response = await post(gate);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-versutus-keepalive-ms'), '15000');
    assert.match(
      await response.text(),
      /: keepalive\n\n/,
      'the vendor relay must send the heartbeat it advertises',
    );
    assert.equal(upstream.state.abandoned, 0, 'the slow answer was completed, not cut off');
  } finally {
    await gate.close();
    upstream.close();
    await removeRoot(root);
  }
});

test('the local-interface iterator branch heartbeats too', async (t) => {
  // The other provider shape: an async iterator of already-parsed events rather
  // than a raw response. It advertises the same header, so it owes the same
  // frame.
  const root = await mkdtemp(join(tmpdir(), 'gate-provider-abort-'));
  t.mock.method(ProviderService.prototype, 'chat', async function chat() {
    return (async function* () {
      // Thinking, then nothing: the silence a heartbeat has to cover.
      await new Promise((resolve) => setTimeout(resolve, 250).unref?.());
    })();
  });
  const { ProviderStore } = await import('../core/providers/store.mjs');
  const gateHome = join(root, '.gate-home');
  await new ProviderStore(gateHome).put({
    schemaVersion: 2, kind: 'provider', id: 'stub', label: 'Stub',
    providerType: 'openai-compatible', enabled: true,
    registration: {
      mode: 'api_key', protocol: 'openai_chat',
      baseUrl: 'https://example.invalid/v1', credentialRef: 'provider/stub/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  });
  const gate = await createGate({ root, gateHome, port: 0, keepaliveIntervalMs: 10 });
  try {
    const response = await post(gate);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-versutus-keepalive-ms'), '15000');
    assert.match(await response.text(), /: keepalive\n\n/, 'the local interface must send the heartbeat it advertises');
  } finally {
    await gate.close();
    await removeRoot(root);
  }
});

test('the profile-adapter path is given a signal, and a live turn is not aborted by it', async (t) => {
  // The v2 provider path hands its fetch to ProviderService.chat; the abort
  // has to travel that far, or a Stop never reaches the vendor.
  const root = await mkdtemp(join(tmpdir(), 'gate-provider-signal-'));
  const gateHome = join(root, '.gate-home');
  const signals = [];
  const abortedMidTurn = [];
  t.mock.method(ProviderService.prototype, 'chat', async function chat(request, signal) {
    signals.push(signal);
    return (async function* () {
      yield 'Hi';
      // Read the signal while the turn is still being consumed: a live turn
      // that nobody stopped must not have been aborted behind the client's
      // back (a watchdog firing on a slow answer, say).
      abortedMidTurn.push(Boolean(signal?.aborted));
    })();
  });
  const { ProviderStore } = await import('../core/providers/store.mjs');
  await new ProviderStore(gateHome).put({
    schemaVersion: 2, kind: 'provider', id: 'stub', label: 'Stub',
    providerType: 'openai-compatible', enabled: true,
    registration: {
      mode: 'api_key', protocol: 'openai_chat',
      baseUrl: 'https://example.invalid/v1', credentialRef: 'provider/stub/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  });
  const gate = await createGate({ root, gateHome, port: 0 });
  try {
    const response = await post(gate);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"content":"Hi"/);
    assert.equal(signals.length, 1);
    assert.ok(signals[0], 'the adapter must be handed a signal to abort its fetch with');
    assert.deepEqual(abortedMidTurn, [false], 'a turn nobody stopped is not aborted');
  } finally {
    await gate.close();
    await removeRoot(root);
  }
});

test('the profile-adapter signal fires when the caller disconnects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gate-provider-signal-'));
  const gateHome = join(root, '.gate-home');
  let signal = null;
  const opened = new Promise((resolve) => {
    t.mock.method(ProviderService.prototype, 'chat', async function chat(_request, passed) {
      signal = passed;
      resolve();
      await new Promise((r) => passed?.addEventListener('abort', r, { once: true }));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
  });
  const { ProviderStore } = await import('../core/providers/store.mjs');
  await new ProviderStore(gateHome).put({
    schemaVersion: 2, kind: 'provider', id: 'stub', label: 'Stub',
    providerType: 'openai-compatible', enabled: true,
    registration: {
      mode: 'api_key', protocol: 'openai_chat',
      baseUrl: 'https://example.invalid/v1', credentialRef: 'provider/stub/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  });
  const gate = await createGate({ root, gateHome, port: 0 });
  try {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      signal: controller.signal,
      body: JSON.stringify({ model: 'stub-1', messages: [], stream: true }),
    });
    pending.catch(() => undefined);
    await opened;
    controller.abort();
    assert.ok(await until(() => signal?.aborted === true), 'a dropped connection must abort the provider call');
  } finally {
    await gate.close();
    await removeRoot(root);
  }
});
