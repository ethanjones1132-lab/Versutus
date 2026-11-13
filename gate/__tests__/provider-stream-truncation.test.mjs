import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

// A vendor stream is only finished when the vendor says so. Each dialect has
// its own terminal frame -- OpenAI-compatible `[DONE]`, Anthropic
// `message_stop` -- and a body that closes without it is a reply cut short:
// a dropped connection, a proxy that gave up, a process that died mid-answer.
// The relay used to read the body's end as the reply's end, so half an answer
// reached the phone with a success-shaped `[DONE]` behind it and the provider
// was recorded as having completed a turn.

const removeRoot = (root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });

const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const errorFrame = {
  error: {
    message: 'The provider cut the reply short: the stream ended before the reply was finished',
    code: 'upstream_error',
  },
};

const openaiDelta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const anthropicDelta = (text) => `data: ${JSON.stringify({
  type: 'content_block_delta',
  delta: { type: 'text_delta', text },
})}\n\n`;

const OPENAI_TERMINAL = 'data: [DONE]\n\n';
const ANTHROPIC_TERMINAL = `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

/** A raw upstream body handing the relay exactly these chunks, then EOF. */
function vendorBody(chunks) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) => encoder.encode(chunk));
  let next = 0;
  return {
    body: {
      getReader: () => ({
        read: async () => (next < encoded.length
          ? { done: false, value: encoded[next++] }
          : { done: true }),
        cancel: async () => {},
      }),
    },
  };
}

/**
 * A Gate holding one provider whose mocked service returns a raw vendor body.
 * `protocol` picks the flavour under test; the mocked chat never reaches the
 * network, so the base URL is only a placeholder.
 */
async function gateWithProvider(t, { protocol }, chunks) {
  const root = await mkdtemp(join(tmpdir(), 'gate-stream-truncation-'));
  t.after(() => removeRoot(root));
  const gateHome = join(root, '.gate-home');
  const store = new ProviderStore(gateHome);
  await store.put({
    schemaVersion: 2,
    kind: 'provider',
    id: 'stub',
    label: 'Stub',
    providerType: protocol === 'anthropic_messages' ? 'anthropic' : 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol,
      baseUrl: 'https://example.invalid/v1',
      credentialRef: 'provider/stub/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  });
  t.mock.method(ProviderService.prototype, 'chat', async () => vendorBody(chunks));
  const gate = await createGate({ root, gateHome, port: 0 });
  t.after(() => gate.close());
  const post = () => fetch(`http://127.0.0.1:${gate.port}/p/stub/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  return { post, store };
}

/** The phone's stream, split into the frames its parser sees. */
async function reply(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  const frames = text.split('\n\n').filter(Boolean).map((frame) => {
    assert.ok(frame.startsWith('data: '));
    const data = frame.slice(6);
    return data === '[DONE]' ? data : JSON.parse(data);
  });
  return { text, frames };
}

const delta = (text) => ({ choices: [{ delta: { content: text } }] });

test('an OpenAI-compatible stream that reaches [DONE] stays a success', async (t) => {
  const { post } = await gateWithProvider(t, { protocol: 'openai_chat' }, [
    openaiDelta('Hel'),
    openaiDelta('lo'),
    OPENAI_TERMINAL,
  ]);

  const { frames } = await reply(await post());

  assert.deepEqual(frames, [delta('Hel'), delta('lo'), '[DONE]']);
});

test('an OpenAI-compatible stream cut before [DONE] is an upstream error, not an answer', async (t) => {
  const { post, store } = await gateWithProvider(t, { protocol: 'openai_chat' }, [
    openaiDelta('Hel'),
    openaiDelta('lo'),
    // The body closes here: no [DONE], so the reply was cut mid-turn.
  ]);

  const { text, frames } = await reply(await post());

  // What arrived is still delivered, in order, and then named as what it is.
  assert.deepEqual(frames, [delta('Hel'), delta('lo'), errorFrame]);
  assert.ok(!text.includes('[DONE]'), 'a cut reply must not reach the phone as a finished one');

  // And the provider is not credited with a turn it never completed.
  assert.ok(
    await until(async () => (await store.get('stub'))?.state?.lastChatOutcome?.ok === false),
    'a cut stream must be recorded as a failed turn',
  );
});

test('an Anthropic stream that reaches message_stop stays a success', async (t) => {
  const { post } = await gateWithProvider(t, { protocol: 'anthropic_messages' }, [
    anthropicDelta('Hel'),
    anthropicDelta('lo'),
    ANTHROPIC_TERMINAL,
  ]);

  const { frames } = await reply(await post());

  assert.deepEqual(frames, [delta('Hel'), delta('lo'), '[DONE]']);
});

test('an Anthropic stream cut before message_stop is an upstream error, not an answer', async (t) => {
  const { post } = await gateWithProvider(t, { protocol: 'anthropic_messages' }, [
    anthropicDelta('Hel'),
    anthropicDelta('lo'),
    // A stop reason is not the end: the reply is only finished at message_stop,
    // and this body closes before it.
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`,
  ]);

  const { text, frames } = await reply(await post());

  assert.deepEqual(frames, [delta('Hel'), delta('lo'), errorFrame]);
  assert.ok(!text.includes('[DONE]'), 'a cut reply must not reach the phone as a finished one');
});

test('a terminal frame without its trailing blank line is still honoured', async (t) => {
  const { post } = await gateWithProvider(t, { protocol: 'openai_chat' }, [
    openaiDelta('hi'),
    // The vendor's own marker, written at the end of the body with no
    // delimiter after it: the marker is what says "finished".
    'data: [DONE]',
  ]);

  const { frames } = await reply(await post());

  assert.deepEqual(frames, [delta('hi'), '[DONE]']);
});

test('a final delta written without a trailing newline still reaches the phone before the error', async (t) => {
  const { post } = await gateWithProvider(t, { protocol: 'openai_chat' }, [
    openaiDelta('Hel'),
    // Cut in the same write as the last text: the delta is real output and is
    // delivered before the truncation is named, not dropped with the cut.
    `data: ${JSON.stringify(delta('lo'))}`,
  ]);

  const { frames } = await reply(await post());

  assert.deepEqual(frames, [delta('Hel'), delta('lo'), errorFrame]);
});
