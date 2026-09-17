import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBackendTurn } from '../core/voice/turn-runner.mjs';

const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

/** An upstream SSE response built from ready-made frames, the way Hermes sends one. */
function sseUpstream(frames) {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
  };
}

/**
 * A backend whose turn behaviour is test-controlled. `streamEvents` emits the
 * given events, then parks until the runner aborts it; `sendMessage` answers
 * `result`. A `sendMessageStreaming` method is present only when `streaming`
 * is set, so tests can exercise the one-call relay path too.
 */
function fakeBackend({ events = [], result = { text: '', message: null }, streaming, streamingError } = {}) {
  const calls = [];
  const backend = {
    calls,
    async streamEvents(sessionId, onEvent, signal) {
      calls.push('streamEvents');
      for (const event of events) onEvent(event);
      await new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', resolve, { once: true });
      });
    },
    async sendMessage(sessionId, input) {
      calls.push('sendMessage');
      return result;
    },
  };
  if (streaming || streamingError) {
    backend.sendMessageStreaming = async (sessionId, input, signal) => {
      calls.push('sendMessageStreaming');
      if (streamingError) throw streamingError;
      return streaming;
    };
  }
  return backend;
}

function collector() {
  const deltas = [];
  const tools = [];
  const approvals = [];
  const chunks = [];
  return {
    deltas,
    tools,
    approvals,
    chunks,
    handlers: {
      onDelta: (text) => deltas.push(text),
      onToolCall: (call) => tools.push(call),
      onApproval: (approval) => approvals.push(approval),
      onChunk: (data) => chunks.push(data),
    },
  };
}

test('reply deltas are reported in order and count as visible content', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [
      { type: 'message.delta', payload: { text: 'Hel' } },
      { type: 'message.delta', payload: { text: 'lo' } },
    ],
    result: { text: '', message: null, runtime: { model: 'gpt-x' } },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.deepEqual(seen.deltas, ['Hel', 'lo']);
  assert.equal(outcome.hasContent, true);
  assert.equal(outcome.report.model, 'gpt-x');
  assert.match(seen.chunks[0], /"content":"Hel"/);
});

test('a tool call is surfaced once and is turn activity even with no text', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [
      { type: 'tool.started', payload: { name: 'read', callId: 'c1' } },
      { type: 'tool.started', payload: { name: 'read', callId: 'c1' } },
    ],
    result: { text: '', message: { role: 'assistant', content: [], tool_calls: [{ name: 'read', id: 'c1' }] } },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'read it' }, seen.handlers);

  assert.deepEqual(seen.tools, [{ index: 0, name: 'read', callId: 'c1' }]);
  assert.equal(outcome.hasContent, true);
  assert.ok(seen.chunks.some((chunk) => /"name":"read"/.test(chunk)));
});

test('an approval event is surfaced without being mistaken for content', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [
      { type: 'approval.required', payload: { approvalId: 'a1', summary: 'Bot needs your approval' } },
    ],
    result: { text: '', message: { role: 'assistant', content: [] } },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'do it' }, seen.handlers);

  assert.deepEqual(seen.approvals, [{ approvalId: 'a1', summary: 'Bot needs your approval' }]);
  assert.equal(outcome.hasContent, false);
});

test('a turn with no text and no tools reports nothing visible', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [],
    result: { text: '', message: { role: 'assistant', content: [] } },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'say nothing' }, seen.handlers);

  assert.equal(outcome.hasContent, false);
  assert.deepEqual(seen.deltas, []);
});

test('a whole-turn result that never streamed is reported once', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [],
    result: { text: 'answered all at once', message: { role: 'assistant', content: [] } },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.deepEqual(seen.deltas, ['answered all at once']);
  assert.equal(outcome.hasContent, true);
});

test('a one-call streaming backend relays every frame and reports its deltas', async () => {
  const seen = collector();
  const backend = fakeBackend({
    streaming: sseUpstream([delta('Hel'), delta('lo'), 'data: [DONE]\n\n']),
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.deepEqual(seen.deltas, ['Hel', 'lo']);
  assert.equal(seen.chunks.length, 2, 'the [DONE] terminator is held back');
  assert.match(seen.chunks[0], /"content":"Hel"/);
  assert.equal(outcome.hasContent, true);
  assert.ok(backend.calls.includes('sendMessageStreaming'));
  assert.ok(!backend.calls.includes('sendMessage'), 'the one-call path must not also run the whole turn');
});

test('a refused stream falls back to the whole turn rather than losing the reply', async () => {
  const seen = collector();
  const backend = fakeBackend({
    streamingError: Object.assign(new Error('hermes: HTTP 404'), { status: 404 }),
    result: { text: 'the fallback answer', message: null },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.deepEqual(seen.deltas, ['the fallback answer']);
  assert.equal(outcome.hasContent, true);
  assert.ok(backend.calls.includes('sendMessage'));
});

test('a backend that names its missing streaming endpoint falls back without a status', async () => {
  const seen = collector();
  const backend = fakeBackend({
    streamingError: Object.assign(new Error('hermes: HTTP 404'), { status: 404, code: 'stream_unsupported' }),
    result: { text: 'the fallback answer', message: null },
  });

  await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.deepEqual(seen.deltas, ['the fallback answer']);
  assert.ok(backend.calls.includes('sendMessage'));
});

test('a streaming POST that may have been accepted is not silently re-sent as a whole turn', async () => {
  const seen = collector();
  const backend = fakeBackend({
    streamingError: Object.assign(new Error('hermes: HTTP 500'), { status: 500 }),
    result: { text: 'the duplicate answer', message: null },
  });

  await assert.rejects(
    () => runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers),
    /HTTP 500/,
  );
  assert.deepEqual(backend.calls, ['sendMessageStreaming']);
});

test('a whole-turn failure on the fallback path still propagates', async () => {
  const backend = fakeBackend({
    streamingError: Object.assign(new Error('hermes: HTTP 404'), { status: 404 }),
  });
  backend.sendMessage = async () => { throw new Error('backend blew up'); };

  await assert.rejects(
    () => runBackendTurn(backend, 'ses_1', { text: 'hi' }, collector().handlers),
    /backend blew up/,
  );
});

test('a streaming POST the caller already aborted never re-sends the turn', async () => {
  const backend = fakeBackend({
    streamingError: Object.assign(new Error('hermes: HTTP 500'), { status: 500 }),
    result: { text: 'must not run', message: null },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, { signal: AbortSignal.abort() });

  assert.equal(outcome.aborted, true);
  assert.deepEqual(backend.calls, ['sendMessageStreaming']);
});

test('a backend error propagates so the caller can name it', async () => {
  const backend = fakeBackend({ events: [] });
  backend.sendMessage = async () => { throw new Error('backend blew up'); };

  await assert.rejects(
    () => runBackendTurn(backend, 'ses_1', { text: 'hi' }, collector().handlers),
    /backend blew up/,
  );
});

test('an already-aborted turn does not start the whole-turn path', async () => {
  const controller = new AbortController();
  controller.abort();
  const backend = fakeBackend({
    streamingError: Object.assign(new Error('aborted'), { status: 500 }),
    result: { text: 'must not run', message: null },
  });

  const seen = collector();
  const outcome = await runBackendTurn(
    backend,
    'ses_1',
    { text: 'hi' },
    { ...seen.handlers, signal: controller.signal },
  );

  assert.equal(outcome.aborted, true);
  assert.equal(outcome.hasContent, false);
  assert.ok(!backend.calls.includes('sendMessage'));
});
