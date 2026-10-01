import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

// A streamed turn was recorded as a success the moment the response headers
// existed, before a byte was relayed. Both relays then handled a mid-stream
// failure themselves and returned, so the one failure that matters most -- the
// common vendor failure on a lossy path -- never reached the record: the
// provider kept `readiness: ready`, the manifest kept advertising it and the
// model picker kept offering it. The phone always asks for `stream: true`.

const READY_AT = '2026-01-01T00:00:00.000Z';

const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function harness(t, { chat, provider = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-stream-outcome-'));
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
      baseUrl: 'http://127.0.0.1:1/v1',
      credentialRef: 'provider/stub/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 5000 },
    ...provider,
  }, {
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: READY_AT },
  });
  if (chat) t.mock.method(ProviderService.prototype, 'chat', chat);
  const gate = await createGate({ root, gateHome, port: 0 });
  const post = (options = {}) => fetch(`http://127.0.0.1:${gate.port}/p/stub/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ model: 'stub-model', messages: [], stream: options.stream !== false }),
    ...options,
  });
  const state = async () => (await store.get('stub'))?.state;
  return {
    gate,
    root,
    store,
    post,
    stored: state,
    // The turn is recorded when the response finishes, and the store write lands
    // a moment after the client's last frame, so a positive assertion waits for
    // the record rather than racing it. A negative one must not: nothing may be
    // written at all, which only a settled read can show.
    recorded: (predicate, ms) => until(async () => predicate(await state()), ms),
  };
}

async function frames(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  return (await response.text()).split('\n\n').filter(Boolean).map((frame) => {
    assert.ok(frame.startsWith('data: '));
    const data = frame.slice(6);
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

const delta = (text) => ({ choices: [{ delta: { content: text } }] });
const interrupted = () => Object.assign(
  new Error('Provider stream interrupted'),
  { code: 'provider_disconnected' },
);

// A Gate that is still flushing its provider store can recreate a file while the
// tree is being removed, which is a lost temp dir, not a failed assertion. The
// same helper provider-chat-abort.test.mjs uses.
const removeRoot = (root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });

const teardown = (t, gate, root) => t.after(async () => {
  await gate.close();
  await removeRoot(root);
});

test('an iterator that dies mid-reply is recorded as a failed turn', async (t) => {
  const { gate, root, post, stored, recorded } = await harness(t, {
    chat: async () => (async function* () {
      yield 'Hel';
      yield 'lo';
      throw interrupted();
    })(),
  });
  teardown(t, gate, root);

  assert.deepEqual(await frames(await post()), [
    delta('Hel'),
    delta('lo'),
    { error: { message: 'Provider stream interrupted', code: 'provider_disconnected' } },
  ]);

  assert.ok(
    await recorded((state) => state?.lastChatOutcome !== undefined),
    'a stream that ended in an error must still be recorded',
  );
  const after = await stored();
  assert.notEqual(after.readiness.state, 'ready', 'a stream that died is not a ready provider');
  assert.equal(after.readiness.code, 'transient_network');
  assert.match(after.lastError.message, /interrupted/i);
  assert.equal(after.lastChatOutcome.ok, false);
});

test('an upstream reader that dies mid-reply is recorded as a failed turn', async (t) => {
  let reads = 0;
  const encoder = new TextEncoder();
  const { gate, root, post, stored, recorded } = await harness(t, {
    chat: async () => ({
      body: {
        getReader: () => ({
          read: async () => {
            if (reads++ < 2) {
              return {
                done: false,
                value: encoder.encode(`data: ${JSON.stringify(delta(reads === 1 ? 'Hel' : 'lo'))}\n\n`),
              };
            }
            throw interrupted();
          },
          cancel: async () => {},
        }),
      },
    }),
  });
  teardown(t, gate, root);

  assert.deepEqual(await frames(await post()), [
    delta('Hel'),
    delta('lo'),
    { error: { message: 'Provider stream interrupted', code: 'provider_disconnected' } },
  ]);

  assert.ok(
    await recorded((state) => state?.lastChatOutcome !== undefined),
    'a reader that died must still be recorded',
  );
  const after = await stored();
  assert.notEqual(after.readiness.state, 'ready');
  assert.equal(after.lastChatOutcome.ok, false);
});

test('a stream that completes is recorded as a real turn', async (t) => {
  const { gate, root, post, stored, recorded } = await harness(t, {
    chat: async () => (async function* () {
      yield 'Hi';
    })(),
  });
  teardown(t, gate, root);

  assert.deepEqual(await frames(await post()), [delta('Hi'), '[DONE]']);

  assert.ok(
    await recorded((state) => state?.lastChatOutcome !== undefined),
    'a completed stream is a turn, and a turn is recorded',
  );
  const after = await stored();
  assert.equal(after.readiness.state, 'ready');
  assert.equal(after.lastChatOutcome.ok, true);
});

test('a client that disconnects mid-stream leaves the outcome untouched', async (t) => {
  let signal = null;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { gate, root, post, stored } = await harness(t, {
    chat: async function chat(_request, passed) {
      signal = passed;
      return (async function* () {
        yield 'Hi';
        await held;
      })();
    },
  });
  teardown(t, gate, root);

  const controller = new AbortController();
  const response = await post({ signal: controller.signal });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"content":"Hi"/);

  controller.abort();
  // A phone pressing Stop closes the socket, and the Gate learns of it a few
  // milliseconds later -- so wait for that before the vendor's turn ends, rather
  // than releasing in the same tick, which would be "Stop" and a clean ending at
  // once and would prove nothing.
  assert.ok(
    await until(() => signal?.aborted === true),
    'the dropped connection must abort the provider call',
  );
  release();
  await new Promise((resolve) => setTimeout(resolve, 250));

  const after = await stored();
  assert.equal(after.lastChatOutcome, undefined, 'pressing Stop must not record an outcome either way');
  assert.equal(after.readiness.state, 'ready');
});

test('a non-streaming turn that completes is still recorded at once', async (t) => {
  const { gate, root, post, stored, recorded } = await harness(t, {
    chat: async () => ({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }),
  });
  teardown(t, gate, root);

  const response = await post({ stream: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Hello');
  assert.ok(
    await recorded((state) => state?.lastChatOutcome !== undefined),
    'the one whole response already decided the turn',
  );
  assert.equal((await stored()).lastChatOutcome.ok, true);
});

test('a disabled provider is a configuration 409 and writes no outcome', async (t) => {
  const { gate, root, post, stored } = await harness(t, { provider: { enabled: false } });
  teardown(t, gate, root);

  const response = await post();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: { message: 'provider "stub" is disabled', code: 'disabled' },
  });
  assert.equal(
    (await stored()).lastChatOutcome,
    undefined,
    'a provider nobody asked anything must not be judged by the turn',
  );
});

test('a provider with no credential is a configuration 409 and writes no outcome', async (t) => {
  const { gate, root, post, stored } = await harness(t);
  teardown(t, gate, root);

  const response = await post();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: { message: 'provider has no credential to send', code: 'missing_credentials' },
  });
  assert.equal((await stored()).lastChatOutcome, undefined);
});