import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';
import { createTurnJournal } from '../core/turns/turn-journal.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

// Provider-routed turns (the Gate's own vendors: OpenRouter, Nvidia, a custom
// endpoint) must obey the same durable-turn contract as backend turns
// (docs/design/durable-turns.md, section 7 / DUR-6). These drive a real Gate
// over HTTP against a real node:http vendor that streams SSE slowly, because
// every claim is about what happens after the phone's socket is gone.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all([...new Set(roots.splice(0))].map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

const TURN_ID = 'turn-prov-01';
const SESSION_ID = 'ses_prov_1';
const REFUSAL = 'HTTP 400: omen-alpha is not a valid model ID';

const sseDelta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

/**
 * A vendor the test controls. It counts requests so a retry can be shown to
 * be exactly-once, and reports whether the Gate tore the upstream socket
 * before the vendor finished — which a named detach must never do.
 */
async function startVendor({
  chunks = ['the whole ', 'answer'],
  hold = false,
  stall = false,
  holdForMs = 0,
  status = 200,
  die = false,
} = {}) {
  const state = { requests: 0, abandoned: 0 };
  let releaseHold = () => {};
  const held = hold ? new Promise((resolve) => { releaseHold = resolve; }) : Promise.resolve();
  // Tests that forget to release must not pin the process; a hung vendor is
  // the defect under test, not a reason to stall node:test.
  if (hold) setTimeout(() => releaseHold(), 8000).unref?.();
  const server = createServer((req, res) => {
    state.requests += 1;
    req.resume();
    res.on('close', () => {
      if (!res.writableFinished) state.abandoned += 1;
    });
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'vendor refused' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    const writeChunk = (text) => {
      if (!res.writableEnded) res.write(sseDelta(text));
    };
    (async () => {
      try {
        if (chunks[0] != null) writeChunk(chunks[0]);
        if (stall) {
          setTimeout(() => { if (!res.writableEnded) res.end(); }, 8000).unref?.();
          return;
        }
        await held;
        if (die) {
          res.destroy();
          return;
        }
        if (holdForMs) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, holdForMs);
            timer.unref?.();
          });
        }
        for (const text of chunks.slice(1)) writeChunk(text);
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch {
        // The Gate cancelled the socket; nothing left to say.
      }
    })();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    release: () => releaseHold(),
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function makeGate(upstreamBaseUrl, { pushFetch, gateOptions } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-durable-prov-'));
  roots.push(root);
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(join(root, 'registry', 'stub.json'), JSON.stringify({
    kind: 'provider',
    label: 'Stub',
    config: {
      flavor: 'openai',
      baseUrl: upstreamBaseUrl,
      apiKeyEnv: 'STUB_KEY',
      models: ['stub-1'],
      streaming: true,
    },
  }), 'utf8');
  process.env.STUB_KEY = 'fake-key-for-tests';
  const gate = await createGate({
    root,
    port: 0,
    voiceWarmStart: false,
    ...(pushFetch ? { pushFetch } : {}),
    ...(gateOptions ?? {}),
  });
  let closed = false;
  return {
    gate,
    root,
    base: `http://127.0.0.1:${gate.port}`,
    close: () => (closed ? Promise.resolve() : (closed = true, gate.close())),
  };
}

/**
 * The v2 ProviderService path is the one that records readiness
 * (`noteTurnOutcome`). The registry-stub Gate above goes through `proxyChat`
 * and never writes lastChatOutcome, so these cases would pass for the wrong
 * reason on that twin.
 */
async function makeV2Gate(upstreamBaseUrl, { gateOptions } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-durable-prov-v2-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  const store = new ProviderStore(gateHome);
  await store.put({
    schemaVersion: 2,
    kind: 'provider',
    id: 'stub',
    label: 'Stub',
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: upstreamBaseUrl,
      credentialRef: 'provider/stub/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 5000 },
  }, {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-01-01T00:00:00.000Z' },
  });
  const vault = new CredentialVault({
    gateHome,
    backend: {
      protect: async (buffer) => buffer,
      unprotect: async (buffer) => buffer,
    },
  });
  await vault.set('provider/stub/api-key', 'fake-key-for-tests');
  const gate = await createGate({
    root,
    gateHome,
    vault,
    port: 0,
    voiceWarmStart: false,
    ...(gateOptions ?? {}),
  });
  let closed = false;
  return {
    gate,
    root,
    store,
    base: `http://127.0.0.1:${gate.port}`,
    close: () => (closed ? Promise.resolve() : (closed = true, gate.close())),
  };
}

const auth = (gate) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${gate.token}`,
});

const streamingTurn = (harness, { turnId, controller, sessionId = SESSION_ID } = {}) => fetch(
  `${harness.base}/v1/chat/completions`,
  {
    method: 'POST',
    headers: {
      ...auth(harness.gate),
      ...(turnId ? { 'X-Versutus-Turn-Id': turnId } : {}),
    },
    signal: controller?.signal,
    body: JSON.stringify({
      providerId: 'stub',
      model: 'stub-1',
      sessionId,
      messages: [{ role: 'user', content: 'say it once' }],
      stream: true,
    }),
  },
);

const turnMeta = async (harness, turnId) => {
  const response = await fetch(`${harness.base}/v1/turns/${turnId}`, {
    headers: { Authorization: `Bearer ${harness.gate.token}` },
  });
  return { status: response.status, body: await response.json() };
};

const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingPush() {
  const pushSends = [];
  const pushFetch = async (url, init) => {
    if (url.endsWith('/push/send')) {
      const messages = JSON.parse(init.body);
      pushSends.push(...messages);
      return {
        ok: true, status: 200,
        async json() { return { data: messages.map((_, index) => ({ status: 'ok', id: `t-${index}` })) }; },
      };
    }
    return {
      ok: true, status: 200,
      async json() { return { data: Object.fromEntries(JSON.parse(init.body).ids.map((id) => [id, { status: 'ok' }])) }; },
    };
  };
  return { pushSends, pushFetch };
}

async function registerPush(harness) {
  for (const [method, params] of [
    ['notifications.register', {
      expoPushToken: 'ExponentPushToken[phone]', platform: 'ios', timezone: 'UTC',
      deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    }],
    ['notifications.preferences.set', {
      enabled: true, richBody: true, deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    }],
  ]) {
    const rpc = await fetch(`${harness.base}/v1/capabilities/rpc`, {
      method: 'POST', headers: auth(harness.gate), body: JSON.stringify({ method, params }),
    });
    assert.equal(rpc.status, 200);
  }
}

test('a detached provider turn finishes into the journal with the whole reply', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: ['the whole ', 'answer'], hold: true });
  const harness = await makeGate(vendor.baseUrl, {
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(harness, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1), 'the vendor must have the turn before the phone leaves');

    controller.abort();
    await pending.catch(() => undefined);
    await sleep(40);
    assert.equal(vendor.state.abandoned, 0, 'closing the phone must not abort the vendor');

    vendor.release();
    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).body.status === 'done'),
      'the turn must run to its own end with nobody watching',
    );
    const { status, body } = await turnMeta(harness, TURN_ID);
    assert.equal(status, 200);
    assert.equal(body.status, 'done');
    assert.equal(body.text, 'the whole answer');
    assert.equal(body.turnId, TURN_ID);
    assert.equal(body.sessionId, SESSION_ID);
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('a retry of a provider turn replays and the vendor is called once', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: ['the whole ', 'answer'], hold: true });
  const harness = await makeGate(vendor.baseUrl, {
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const first = streamingTurn(harness, { turnId: TURN_ID, controller });
    first.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1));

    // The phone drops, then retries the same send. The vendor must not see a
    // second turn: the retry is a subscriber of the one already running.
    controller.abort();
    await first.catch(() => undefined);
    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).status === 200),
      'the original send must already be on the journal before the retry',
    );

    const retry = await streamingTurn(harness, { turnId: TURN_ID });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-versutus-turn-resumed'), '1');
    assert.equal(vendor.state.requests, 1, 'a retry must never start a second vendor call');

    vendor.release();
    const body = await retry.text();
    assert.match(body, /the whole /);
    assert.ok(body.endsWith('data: [DONE]\n\n'));
    assert.equal((await turnMeta(harness, TURN_ID)).body.text, 'the whole answer');
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('closing the Gate mid-provider-stream is gate_restart, not a finished reply', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: ['half an ', 'answer'], hold: true });
  const harness = await makeGate(vendor.baseUrl);
  try {
    const pending = streamingTurn(harness, { turnId: TURN_ID });
    pending.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1));
    await harness.close();
    const body = await (await pending).text();

    assert.match(body, /gate_restart/);
    assert.match(body, /The Gate restarted while this turn was running\./);
    assert.ok(!body.includes('[DONE]'), 'a restart must never end an attached stream as a success');

    const after = createTurnJournal({ dir: join(harness.root, '.gate-home', 'turns') });
    const known = await after.get('bootstrap-token', TURN_ID);
    assert.equal(known?.status, 'interrupted');
    assert.equal(known?.reason, 'gate_restart');
    await after.close();
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('a turn id known only from before a restart replays what the journal has', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: ['half an ', 'answer'], hold: true });
  const first = await makeGate(vendor.baseUrl, {
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(first, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1));
    // The phone is gone and then the process is: the next Gate must replay
    // what the last one recorded, never start the vendor a second time.
    controller.abort();
    await pending.catch(() => undefined);
    await first.close();
    vendor.release();

    const restarted = await makeGate(vendor.baseUrl, {
      gateOptions: { turnsDir: join(first.root, '.gate-home', 'turns') },
    });
    try {
      const retry = await streamingTurn(restarted, { turnId: TURN_ID });
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('x-versutus-turn-resumed'), '1');
      const body = await retry.text();
      assert.match(body, /gate_restart/);
      assert.equal(vendor.state.requests, 1, 'a restart replay must not call the vendor again');
      assert.equal((await turnMeta(restarted, TURN_ID)).body.status, 'interrupted');
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
    await vendor.close();
  }
});

test('a stalled vendor after the phone left is interrupted/stalled', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: ['half an '], stall: true });
  const harness = await makeGate(vendor.baseUrl, {
    gateOptions: { detachedStallMs: 50, detachedTurnMaxMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(harness, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1));
    controller.abort();
    await pending.catch(() => undefined);

    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).body.status === 'interrupted'),
      'a silent vendor must be ended, not waited on forever',
    );
    const { body } = await turnMeta(harness, TURN_ID);
    assert.equal(body.status, 'interrupted');
    assert.equal(body.reason, 'stalled');
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('Stop of a provider turn is journalled as cancelled', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: ['half an ', 'answer'], hold: true });
  const harness = await makeGate(vendor.baseUrl, {
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000 },
  });
  try {
    const pending = streamingTurn(harness, { turnId: TURN_ID });
    pending.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1));

    const stopped = await fetch(`${harness.base}/v1/chat/cancel`, {
      method: 'POST',
      headers: auth(harness.gate),
      body: JSON.stringify({ turnId: TURN_ID }),
    });
    assert.deepEqual(await stopped.json(), { cancelled: true });

    const cancelled = await until(async () => (await turnMeta(harness, TURN_ID)).body.status === 'cancelled');
    vendor.release();
    await pending.catch(() => undefined);
    assert.ok(cancelled, 'Stop must land on the journal as cancelled');
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('the push after a detached provider completion carries the real reply', { timeout: 15_000 }, async () => {
  const { pushSends, pushFetch } = recordingPush();
  const reply = `the whole answer ${'and all of its later words'.repeat(200)}`;
  const vendor = await startVendor({ chunks: [reply], hold: true });
  const harness = await makeGate(vendor.baseUrl, {
    pushFetch,
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    await registerPush(harness);
    const pending = streamingTurn(harness, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1));
    controller.abort();
    await pending.catch(() => undefined);
    vendor.release();

    assert.ok(await until(() => pushSends.length === 1), 'a detached provider turn that finished must still push');
    const notice = pushSends.find((message) => message.data?.kind === 'reply');
    assert.equal(notice.data.sessionId, SESSION_ID);
    assert.equal(notice.body, `${reply.slice(0, 80)}…`);
    assert.equal((await turnMeta(harness, TURN_ID)).body.text, reply);
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('an upstream refusal is a recorded failure, not a done turn', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: [REFUSAL] });
  const harness = await makeGate(vendor.baseUrl);
  try {
    const live = await streamingTurn(harness, { turnId: TURN_ID });
    assert.equal(live.status, 200);
    await live.text();

    const { status, body } = await turnMeta(harness, TURN_ID);
    assert.equal(status, 200);
    assert.equal(body.status, 'failed');
    assert.match(body.text ?? '', /HTTP 400/);
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('a detached provider turn that completes leaves provider readiness untouched', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: ['the whole ', 'answer'], hold: true });
  const harness = await makeV2Gate(vendor.baseUrl, {
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(harness, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1));
    controller.abort();
    await pending.catch(() => undefined);
    await sleep(40);
    vendor.release();
    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).body.status === 'done'),
      'the detached turn must still finish',
    );
    // noteTurnOutcome is async after the journal lands; a buggy record would
    // appear in this window. Waiting it out is what makes the assertion able
    // to fail.
    await sleep(250);
    const after = (await harness.store.get('stub'))?.state;
    assert.equal(after.lastChatOutcome, undefined, 'a phone that left must not be a verdict on the provider');
    assert.equal(after.readiness.state, 'ready');
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('a detached provider failure leaves provider readiness untouched', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ chunks: ['half an '], hold: true, die: true });
  const harness = await makeV2Gate(vendor.baseUrl, {
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(harness, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => vendor.state.requests === 1));
    controller.abort();
    await pending.catch(() => undefined);
    await sleep(40);
    vendor.release();
    assert.ok(
      await until(async () => (await turnMeta(harness, TURN_ID)).body.status === 'failed'),
      'the vendor dying after the phone left must still close the journal as failed',
    );
    await sleep(250);
    const after = (await harness.store.get('stub'))?.state;
    assert.equal(after.lastChatOutcome, undefined, 'a failure the operator walked away from must not flip readiness');
    assert.equal(after.readiness.state, 'ready');
  } finally {
    await harness.close();
    await vendor.close();
  }
});

test('a pre-stream provider failure replays with an error frame', { timeout: 15_000 }, async () => {
  const vendor = await startVendor({ status: 502 });
  const harness = await makeV2Gate(vendor.baseUrl);
  try {
    const live = await streamingTurn(harness, { turnId: TURN_ID });
    assert.equal(live.status, 502);
    await live.text();

    const { body: meta } = await turnMeta(harness, TURN_ID);
    assert.equal(meta.status, 'failed');

    const retry = await streamingTurn(harness, { turnId: TURN_ID });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-versutus-turn-resumed'), '1');
    assert.equal(vendor.state.requests, 1, 'a failed turn id is still exactly-once');
    const replayed = await retry.text();
    assert.match(replayed, /"error"/, 'replay of a pre-stream failure must carry the error frame');
    assert.match(replayed, /502/);
    assert.ok(replayed.includes('[DONE]'));
  } finally {
    await harness.close();
    await vendor.close();
  }
});
