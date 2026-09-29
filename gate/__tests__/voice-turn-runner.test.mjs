import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import { runBackendTurn } from '../core/voice/turn-runner.mjs';

const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

/**
 * Move a mock clock forward in small steps, draining the microtask queue
 * between them.
 *
 * A turn that is waiting on a timer has to be observed the way it would be in
 * real time: a bound armed halfway through the advance must be able to fire
 * before the answer it would have cut short. Draining microtasks between steps
 * lets the runner reach that point instead of arming everything at once.
 */
async function advanceClock(t, totalMs, stepMs = 500) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    t.mock.timers.tick(stepMs);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

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

test('reasoning and tool completion cross the typed-turn stream before the reply', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [
      { type: 'message.reasoning.delta', payload: { text: 'checking files' } },
      { type: 'tool.started', payload: { name: 'Read', callId: 'c1' } },
      { type: 'tool.output', payload: { name: 'Read', callId: 'c1', status: 'completed' } },
      { type: 'message.delta', payload: { text: 'Done' } },
    ],
    result: { text: 'Done' },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'read it' }, seen.handlers);
  const frames = seen.chunks.map((chunk) => JSON.parse(chunk).choices[0].delta);
  assert.ok(Number.isFinite(frames[2].tool_calls[0].durationMs));
  delete frames[2].tool_calls[0].durationMs;
  assert.deepEqual(frames, [
    { reasoning_content: 'checking files' },
    { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read' }, status: 'running' }] },
    { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read' }, status: 'complete' }] },
    { content: 'Done' },
  ]);
  assert.equal(outcome.hasContent, true);
});

test('tool output streams bounded detail while the card remains running', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [
      { type: 'tool.started', payload: { name: 'exec', callId: 'c1' } },
      { type: 'tool.progress', payload: { name: 'exec', callId: 'c1', text: 'first line' } },
      { type: 'tool.output', payload: { name: 'exec', callId: 'c1' } },
    ],
    result: { text: '', message: { tool_calls: [{ id: 'c1', name: 'exec' }] } },
  });
  await runBackendTurn(backend, 'ses_1', { text: 'run it' }, seen.handlers);
  const frames = seen.chunks.map((chunk) => JSON.parse(chunk).choices[0].delta.tool_calls[0]);
  assert.equal(frames[1].status, 'running');
  assert.equal(frames[1].detail, 'first line');
  assert.equal(frames[2].status, 'complete');
  assert.equal(frames[2].detail, 'first line');
});

test('tool argument snapshots update by call id and duplicate snapshots are suppressed', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [
      { type: 'tool.started', payload: { name: 'Read', callId: 'c1' } },
      { type: 'tool.progress', payload: { name: 'Read', callId: 'c1', input: { file_path: 'A' }, snapshot: true } },
      { type: 'tool.progress', payload: { name: 'Read', callId: 'c1', input: { file_path: 'A' }, snapshot: true } },
      { type: 'tool.progress', payload: { name: 'Read', callId: 'c1', input: { file_path: 'AGENTS.md' }, snapshot: true } },
      { type: 'tool.output', payload: { name: 'Read', callId: 'c1', output: 'read complete' } },
    ],
    result: { text: '', message: { tool_calls: [{ name: 'Read', id: 'c1' }] } },
  });

  await runBackendTurn(backend, 'ses_1', { text: 'read it' }, seen.handlers);

  const frames = seen.chunks.map((chunk) => JSON.parse(chunk).choices[0].delta.tool_calls[0]);
  assert.deepEqual(frames.map(({ status, detail }) => ({ status, detail })), [
    { status: 'running', detail: undefined },
    { status: 'running', detail: '{"file_path":"A"}' },
    { status: 'running', detail: '{"file_path":"AGENTS.md"}' },
    { status: 'complete', detail: 'read complete' },
  ]);
  assert.ok(frames.every((frame) => frame.id === 'c1'));
});

test('an in-flight snapshot can establish a tool card when the start event was missed', async () => {
  const seen = collector();
  const backend = fakeBackend({
    events: [
      { type: 'tool.progress', payload: { name: 'exec', callId: 'c2', input: { command: 'git status' }, snapshot: true } },
    ],
    result: { text: '', message: { tool_calls: [{ name: 'exec', id: 'c2' }] } },
  });

  await runBackendTurn(backend, 'ses_1', { text: 'check it' }, seen.handlers);

  const frame = JSON.parse(seen.chunks[0]).choices[0].delta.tool_calls[0];
  assert.equal(frame.id, 'c2');
  assert.equal(frame.status, 'running');
  assert.equal(frame.detail, '{"command":"git status"}');
  assert.deepEqual(seen.tools, [{ index: 0, name: 'exec', callId: 'c2', detail: '{"command":"git status"}' }]);
});

test('a per-turn backend delivers live events through sendMessage callback', async () => {
  const seen = collector();
  const backend = {
    async sendMessage(_sessionId, _input, onEvent) {
      onEvent({ type: 'message.reasoning.delta', payload: { text: 'thinking now' } });
      onEvent({ type: 'tool.started', payload: { name: 'Read', callId: 'c1' } });
      onEvent({ type: 'tool.output', payload: { name: 'Read', callId: 'c1' } });
      onEvent({ type: 'message.delta', payload: { text: 'done' } });
      return { text: 'done' };
    },
  };

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'read it' }, seen.handlers);
  assert.equal(outcome.hasContent, true);
  assert.deepEqual(seen.deltas, ['done']);
  assert.equal(seen.chunks.length, 4);
});

test('the turn waits for an asynchronous event feed before sending', async () => {
  let openFeed;
  let ready = false;
  const backend = {
    streamEvents(_sessionId, _onEvent, signal) {
      const done = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      done.ready = new Promise((resolve) => { openFeed = () => { ready = true; resolve(); }; });
      return done;
    },
    async sendMessage() {
      assert.equal(ready, true, 'the opening event must not race the turn');
      return { text: 'ok' };
    },
  };
  const pending = runBackendTurn(backend, 'ses_1', { text: 'hi' }, collector().handlers);
  assert.equal(typeof openFeed, 'function');
  openFeed();
  assert.equal((await pending).hasContent, true);
});

test('an unavailable event feed reports degraded telemetry but keeps the answer', async () => {
  const seen = collector();
  const backend = {
    streamEvents() {
      const done = Promise.reject(new Error('feed refused'));
      done.ready = done;
      return done;
    },
    async sendMessage() { return { text: 'answer' }; },
  };
  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);
  assert.equal(outcome.hasContent, true);
  assert.deepEqual(seen.deltas, ['answer']);
  assert.match(JSON.parse(seen.chunks[0]).telemetry.message, /live.*unavailable/i);
});

test('a rejected event feed after readiness warns once and keeps the backend answer', async () => {
  const seen = collector();
  const backend = {
    streamEvents() {
      const done = Promise.reject(new Error('event stream ended before a terminal event'));
      done.ready = Promise.resolve();
      return done;
    },
    async sendMessage() { return { text: 'answer' }; },
  };

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.equal(outcome.hasContent, true);
  assert.deepEqual(seen.deltas, ['answer']);
  const warnings = seen.chunks.filter((chunk) => JSON.parse(chunk).telemetry?.status === 'degraded');
  assert.equal(warnings.length, 1);
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

// The upstream contract is OpenAI-shaped SSE: a real turn ends with `[DONE]`
// or a `finish_reason` chunk. A body that delivers an answer and then simply
// stops was cut off mid-turn — reporting it as success would hand the caller a
// truncated reply as if it were complete, and re-sending it would run a turn
// that may already have been accepted a second time.
test('a relay stream that ends before its terminal frame is rejected, not faked as complete', async () => {
  const seen = collector();
  const backend = fakeBackend({
    streaming: sseUpstream([delta('Hel')]),
    result: { text: 'the whole-turn answer', message: null },
  });

  await assert.rejects(
    () => runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers),
    (error) => error?.code === 'stream_truncated'
      && /ended before/.test(error.message)
      && /EOF/.test(error.cause?.message ?? ''),
  );
  assert.deepEqual(
    backend.calls,
    ['sendMessageStreaming'],
    'a turn that may already have been accepted is never re-sent',
  );
  assert.deepEqual(seen.deltas, ['Hel'], 'the partial reply that did arrive is still reported');
});

test('a finish_reason chunk is a supported terminal, not a truncation', async () => {
  const seen = collector();
  const backend = fakeBackend({
    streaming: sseUpstream([
      delta('done'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    ]),
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.deepEqual(seen.deltas, ['done']);
  assert.equal(outcome.hasContent, true);
});

test('a CRLF-framed relay stream is parsed and its terminal recognised', async () => {
  const seen = collector();
  const encoder = new TextEncoder();
  const crlf = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`;
  const backend = fakeBackend({
    streaming: {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(crlf('Hel')));
          controller.enqueue(encoder.encode(crlf('lo')));
          controller.enqueue(encoder.encode('data: [DONE]\r\n\r\n'));
          controller.close();
        },
      }),
    },
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.deepEqual(seen.deltas, ['Hel', 'lo']);
  assert.equal(outcome.hasContent, true);
});

test('a terminal buffered without a trailing blank line is still honoured', async () => {
  const seen = collector();
  const backend = fakeBackend({
    streaming: sseUpstream([delta('hi'), 'data: [DONE]']),
  });

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers);

  assert.deepEqual(seen.deltas, ['hi']);
  assert.equal(outcome.hasContent, true);
});

// The caller leaving ends the turn even when the stream will not cooperate: a
// read that never settles and a cancel that ignores the abort must not hold the
// runner, and no callback may cross the wire once the turn is over.
test('an abort settles a relay whose read and cancel both ignore it', async () => {
  const encoder = new TextEncoder();
  let reads = 0;
  const upstream = {
    body: {
      getReader: () => ({
        read() {
          reads += 1;
          if (reads === 1) {
            return Promise.resolve({ done: false, value: encoder.encode(delta('live')) });
          }
          return new Promise(() => {});
        },
        cancel() { return new Promise(() => {}); },
      }),
    },
  };
  const backend = { async sendMessageStreaming() { return upstream; } };

  const caller = new AbortController();
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    onDelta: () => {},
    onChunk: () => {},
    signal: caller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  const settled = await Promise.race([
    turn.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
  ]);

  assert.notEqual(settled, 'hung', 'a blocked relay must not outlive the abort');
  assert.equal(settled.error, undefined, `an aborted turn does not end as an error: ${settled.error?.message}`);
  assert.equal(settled.value?.aborted, true);
});

test('an abort suppresses a late frame batch even when read ignores it', async () => {
  const deltas = [];
  const encoder = new TextEncoder();
  let reads = 0;
  const upstream = {
    body: {
      getReader: () => ({
        read() {
          reads += 1;
          if (reads === 1) {
            return Promise.resolve({ done: false, value: encoder.encode(delta('live')) });
          }
          return new Promise((resolve) => {
            setTimeout(() => resolve({ done: false, value: encoder.encode(delta('late')) }), 40);
          });
        },
        cancel() { return new Promise(() => {}); },
      }),
    },
  };
  const backend = { async sendMessageStreaming() { return upstream; } };

  const caller = new AbortController();
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    onDelta: (text) => deltas.push(text),
    onChunk: () => {},
    signal: caller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  const outcome = await turn;
  assert.equal(outcome.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(deltas, ['live'], 'no callback crosses the wire after the abort');
});

// A terminal frame ends the turn even though the stream is still open. Waiting
// for EOF parks the relay on a read whose sender may never close, so a turn
// that already reached its terminator is held open behind it.
test('a relay returns on [DONE] without waiting for the next read', async () => {
  const encoder = new TextEncoder();
  let reads = 0;
  const upstream = {
    body: {
      getReader: () => ({
        read() {
          reads += 1;
          if (reads === 1) {
            return Promise.resolve({ done: false, value: encoder.encode('data: [DONE]\n\n') });
          }
          return new Promise(() => {});
        },
        cancel() { return new Promise(() => {}); },
      }),
    },
  };
  const backend = { async sendMessageStreaming() { return upstream; } };

  const settled = await Promise.race([
    runBackendTurn(backend, 'ses_1', { text: 'hi' }, { onDelta() {}, onChunk() {} })
      .then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
  ]);

  assert.notEqual(settled, 'hung', 'a terminal frame must end the relay without EOF');
  assert.equal(settled.error, undefined, `a terminal turn does not end as an error: ${settled.error?.message}`);
});

test('a relay returns on finish_reason without waiting for the next read', async () => {
  const encoder = new TextEncoder();
  const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
  let reads = 0;
  const upstream = {
    body: {
      getReader: () => ({
        read() {
          reads += 1;
          if (reads === 1) {
            return Promise.resolve({ done: false, value: encoder.encode(delta('done') + finish) });
          }
          return new Promise(() => {});
        },
        cancel() { return new Promise(() => {}); },
      }),
    },
  };
  const backend = { async sendMessageStreaming() { return upstream; } };
  const deltas = [];

  const settled = await Promise.race([
    runBackendTurn(backend, 'ses_1', { text: 'hi' }, { onDelta: (text) => deltas.push(text), onChunk() {} })
      .then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
  ]);

  assert.notEqual(settled, 'hung', 'a finish_reason must end the relay without EOF');
  assert.equal(settled.error, undefined, `a terminal turn does not end as an error: ${settled.error?.message}`);
  assert.deepEqual(deltas, ['done']);
});

// One frame may carry content and tool calls together. A caller that hangs up
// while its onChunk reports that frame has ended the turn, and the parsed
// events hiding behind the same frame must not cross the wire after it.
test('an onChunk abort inside one frame suppresses its own content and tools', async () => {
  const deltaAndTool = `data: ${JSON.stringify({
    choices: [{ delta: {
      content: 'never mind',
      tool_calls: [{ index: 0, id: 'c1', function: { name: 'read' } }],
    } }],
  })}\n\n`;
  const encoder = new TextEncoder();
  let reads = 0;
  const upstream = {
    body: {
      getReader: () => ({
        read() {
          reads += 1;
          if (reads === 1) return Promise.resolve({ done: false, value: encoder.encode(deltaAndTool) });
          return new Promise(() => {});
        },
        cancel() { return new Promise(() => {}); },
      }),
    },
  };
  const backend = { async sendMessageStreaming() { return upstream; } };

  const deltas = [];
  const tools = [];
  const caller = new AbortController();
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    onDelta: (text) => deltas.push(text),
    onToolCall: (call) => tools.push(call),
    onChunk: () => caller.abort(),
    signal: caller.signal,
  });

  const settled = await Promise.race([
    turn.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
  ]);

  assert.notEqual(settled, 'hung', 'the abort must release the relay mid-frame');
  assert.deepEqual(deltas, [], 'content behind an aborting onChunk must not be reported');
  assert.deepEqual(tools, [], 'tools behind an aborting onChunk must not be reported');
});

// A reader whose cancel is missing or throws must not turn a caller hanging up
// into a turn failure: the release is best-effort, not a required step.
test('a reader without a cancel still releases the turn on abort', async () => {
  const upstream = {
    body: {
      getReader: () => ({
        read() { return new Promise(() => {}); },
        cancel: undefined,
      }),
    },
  };
  const backend = { async sendMessageStreaming() { return upstream; } };
  const caller = new AbortController();
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    onDelta() {}, onChunk() {}, signal: caller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  const settled = await Promise.race([
    turn.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
  ]);

  assert.notEqual(settled, 'hung', 'a missing cancel must not park the relay');
  assert.equal(settled.error, undefined, `a missing cancel is not a turn error: ${settled.error?.message}`);
  assert.equal(settled.value?.aborted, true);
});

test('a cancel that throws synchronously still releases the turn on abort', async () => {
  const upstream = {
    body: {
      getReader: () => ({
        read() { return new Promise(() => {}); },
        cancel() { throw new Error('cancel exploded'); },
      }),
    },
  };
  const backend = { async sendMessageStreaming() { return upstream; } };
  const caller = new AbortController();
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    onDelta() {}, onChunk() {}, signal: caller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  const settled = await Promise.race([
    turn.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
  ]);

  assert.notEqual(settled, 'hung', 'a throwing cancel must not park the relay');
  assert.equal(settled.error, undefined, `a throwing cancel is not a turn error: ${settled.error?.message}`);
  assert.equal(settled.value?.aborted, true);
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

// The live wait the incident named: finals reached the Gate at 19:09:21 and
// 19:09:23, the runner had already handed the turn to the backend, and the only
// thing that ever came back was the 180 s turn timeout at 19:12:21. A final is
// exactly when `sendMessage` is invoked, so the turn had started; what the
// runner cannot do is return while the backend's own promise hangs. That promise
// is raced against the caller's abort signal, which is the one lever the socket
// holds to reclaim the turn. An abort has to settle the runner even when
// `sendMessageStreaming` answers a Response whose body never delivers a frame —
// the Hermes shape, and the only shape whose promise outlives abort here.
test('an abort settles a one-call turn whose stream never delivers a frame', async () => {
  const controller = new AbortController();
  let resolved = false;
  const backend = {
    async sendMessageStreaming() {
      // The POST answered and the turn was accepted; the body then goes quiet.
      // Nothing in here observes the signal, so only the runner's own race can
      // end the wait.
      return {
        body: new ReadableStream({
          start(streamController) {
            controller.signal.addEventListener('abort', () => {
              try { streamController.close(); } catch { /* already closed */ }
            }, { once: true });
          },
        }),
      };
    },
  };

  const pending = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    signal: controller.signal,
  }).then((outcome) => {
    resolved = true;
    return outcome;
  });

  // The phone mutes/ends while the reply is still awaited; the socket aborts.
  controller.abort();
  const settled = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('hung'), 300)),
  ]);

  assert.notEqual(settled, 'hung', 'an aborted turn must not wait out the turn timeout');
  assert.equal(resolved, true);
  assert.equal(settled.aborted, true);
  assert.equal(settled.hasContent, false);
});

// The whole-turn finally stops the event subscription, and stopping is not
// waiting: a feed that ignores the abort and never settles must not be able to
// hold a turn that is already over. Here the over is `sendMessage` answering —
// the reply exists, so the runner's answer has to reach the caller anyway.
test('a completed whole turn settles even when its event subscription never resolves', async () => {
  const seen = collector();
  const backend = {
    streamEvents() {
      // Nothing in here observes the signal, so the promise can never settle.
      return new Promise(() => {});
    },
    async sendMessage() { return { text: 'answered anyway' }; },
  };

  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, seen.handlers)
    .then((value) => ({ value }), (error) => ({ error }));
  const settled = await Promise.race([
    turn,
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 300)),
  ]);

  assert.notEqual(settled, 'still-waiting', 'a finished turn must not wait on its subscription');
  assert.equal(settled.error, undefined, `a finished turn does not end as an error: ${settled.error?.message}`);
  assert.equal(settled.value.hasContent, true);
  assert.deepEqual(seen.deltas, ['answered anyway']);
});

// The same subscription on the other ending: the caller hangs up while the
// backend's own turn is still parked. The abort is the runner's last word, so
// it has to settle the call rather than park in the finally that stops the feed.
test('an abort settles a whole turn whose event subscription ignores it', async () => {
  const backend = {
    streamEvents() {
      return new Promise(() => {});
    },
    sendMessage() {
      return new Promise(() => {});
    },
  };

  const caller = new AbortController();
  const seen = collector();
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    ...seen.handlers,
    signal: caller.signal,
  }).then((value) => ({ value }), (error) => ({ error }));
  // Let the runner subscribe and send before the phone goes quiet.
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  const settled = await Promise.race([
    turn,
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 300)),
  ]);

  assert.notEqual(settled, 'still-waiting', 'an aborted turn must not wait on its subscription');
  assert.equal(settled.error, undefined, `a cancelled turn does not end as an error: ${settled.error?.message}`);
  assert.equal(settled.value?.aborted, true, 'the turn settles as aborted');
  assert.equal(
    getEventListeners(caller.signal, 'abort').length,
    0,
    'the runner leaves no abort listener behind on the caller signal',
  );
});

// A caller that knows its backend better than the shared runner does can still
// ask for a bound, and these two keep that escape hatch honest. Nothing opts in
// by default — see the slow-turn and cancellation cases below for why — so the
// bound is only ever reached through an explicit `stallTimeoutMs`.
test('a caller that opts in is told when a turn it accepted goes silent', async () => {
  const seen = collector();
  const stages = [];
  let aborted = false;
  const backend = {
    streamEvents(_sessionId, _onEvent, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
    },
    // Accepted: the promise is created and simply never settles, and the feed
    // above delivers nothing. Only a stall bound can end the wait.
    sendMessage() {
      return new Promise(() => {});
    },
  };

  await assert.rejects(
    () => runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
      ...seen.handlers,
      onStage: (detail) => stages.push(detail),
      stallTimeoutMs: 40,
    }),
    (error) => error?.code === 'backend_stall' && /stall/i.test(error.message),
  );
  assert.ok(stages.some((stage) => stage.stage === 'turn.send'));
  assert.ok(
    !stages.some((stage) => stage.stage === 'turn.accepted'),
    'a backend that never answers is never reported as having accepted the turn',
  );
  assert.ok(
    stages.some((stage) => stage.stage === 'turn.stalled' && stage.blockedOn === 'the backend turn'),
    'the stalled stage names what the runner was waiting on',
  );
  assert.equal(aborted, true, 'a wedged backend is aborted, not left running beside the call');
});

test('activity resets an opted-in stall clock so a slow turn that is still working survives', async () => {
  const seen = collector();
  const stages = [];
  const backend = {
    streamEvents(_sessionId, onEvent, signal) {
      const tick = setTimeout(
        () => onEvent({ type: 'message.reasoning.delta', payload: { text: 'still working' } }),
        50,
      );
      tick.unref?.();
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
    },
    sendMessage() {
      // Slower than the stall window, but the reasoning delta above lands first.
      return new Promise((resolve) => {
        const done = setTimeout(() => resolve({ text: 'answered' }), 100);
        done.unref?.();
      });
    },
  };

  const outcome = await runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    ...seen.handlers,
    onStage: (detail) => stages.push(detail),
    stallTimeoutMs: 80,
  });

  assert.equal(outcome.hasContent, true);
  assert.ok(stages.some((stage) => stage.stage === 'turn.activity'));
  assert.ok(!stages.some((stage) => stage.stage === 'turn.stalled'));
});

test('acceptance is only claimed once the backend answers, never at send time', async () => {
  const stages = [];
  let releaseSend;
  let sendEntered = false;
  const backend = {
    sendMessage() {
      sendEntered = true;
      return new Promise((resolve) => { releaseSend = () => resolve({ text: 'answered' }); });
    },
  };
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    onStage: (detail) => stages.push(detail),
    attempt: 'a1',
    backendId: 'hermes',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendEntered, true, 'the send was actually invoked');
  assert.ok(stages.some((stage) => stage.stage === 'turn.send' && stage.path === 'whole-turn'));
  assert.ok(
    stages.every((stage) => stage.attempt === 'a1' && stage.backend === 'hermes'),
    'every stage names the attempt and the backend descriptor',
  );
  assert.ok(
    !stages.some((stage) => stage.stage === 'turn.accepted'),
    'no acceptance is claimed while the backend send is unresolved',
  );

  releaseSend();
  const outcome = await turn;
  assert.equal(outcome.hasContent, true);
  const names = stages.map((stage) => stage.stage);
  assert.ok(names.indexOf('turn.send') < names.indexOf('turn.accepted'));
  assert.ok(names.indexOf('turn.accepted') < names.indexOf('turn.response'));
  assert.ok(names.indexOf('turn.response') <= names.indexOf('turn.settled'));
});

test('the streaming path sends, accepts the answered POST, then reports the response', async () => {
  const seen = collector();
  const stages = [];
  let releasePost;
  const backend = {
    sendMessageStreaming() {
      return new Promise((resolve) => {
        releasePost = () => resolve(sseUpstream([delta('hi'), 'data: [DONE]\n\n']));
      });
    },
  };
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    ...seen.handlers,
    onStage: (detail) => stages.push(detail),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(stages.some((stage) => stage.stage === 'turn.send' && stage.path === 'streaming'));
  assert.ok(
    !stages.some((stage) => stage.stage === 'turn.accepted'),
    'an unanswered POST is not acceptance',
  );

  releasePost();
  await turn;
  const names = stages.map((stage) => stage.stage);
  assert.ok(names.indexOf('turn.send') < names.indexOf('turn.accepted'));
  assert.ok(names.indexOf('turn.accepted') < names.indexOf('turn.response'));
  assert.deepEqual(seen.deltas, ['hi']);
});

// A shared default bound judges a turn by its silence, and silence is not
// evidence. The 2026-09-19 incident is the case: Hermes took two and a half
// minutes to answer under database contention and the turn was valid the whole
// time. Any default that cannot tell a slow turn from a dead one takes the slow
// ones with it, and it takes them on the typed path too, which never asked for
// a bound at all. Waiting is the runner's job; how long is the caller's.
test('a valid turn that is silent for minutes is answered, not cut off by a default bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const seen = collector();
  const stages = [];
  const backend = {
    // No sign of life at all for 90 s -- past the minute a default bound used
    // to impose -- and then a complete, ordinary answer.
    sendMessage() {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ text: 'sorry, that took a while' }), 90_000);
      });
    },
  };

  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    ...seen.handlers,
    onStage: (detail) => stages.push(detail),
  });
  await advanceClock(t, 120_000);

  const outcome = await turn;
  assert.equal(outcome.hasContent, true, 'a slow but valid turn is still answered');
  assert.deepEqual(seen.deltas, ['sorry, that took a while']);
  assert.ok(
    !stages.some((stage) => stage.stage === 'turn.stalled'),
    'a turn that is merely slow is never reported as stalled',
  );
  // The telemetry that makes a silent turn attributable survives: a caller
  // still gets told the turn was accepted, and where it got to.
  assert.ok(stages.some((stage) => stage.stage === 'turn.accepted'));
  assert.ok(stages.some((stage) => stage.stage === 'turn.settled'));
});

// Cancelling is the caller's decision and the last word in the turn. The
// runner must let go of it at once: a bound still armed after the caller left
// fires minutes later against a call that is already gone, and reports it
// stalled. The 2026-09-19 call sat in exactly that shape -- finals delivered,
// `sendMessage` invoked, nothing coming back -- and the log had to say which
// step it was parked on rather than leave the call waiting on a verdict.
test('a cancelled streaming turn is released at once, never left to a stall verdict', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const stages = [];
  const deltas = [];
  const upstream = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(delta('working on it')));
        // Never closed, never another frame: the read the relay parks on
        // cannot return on its own, so only the caller can end this turn.
      },
    }),
  };
  const backend = {
    async sendMessageStreaming() { return upstream; },
  };

  const caller = new AbortController();
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    onDelta: (text) => deltas.push(text),
    onChunk: () => {},
    onStage: (detail) => stages.push(detail),
    signal: caller.signal,
  });
  // Let the POST resolve and the opening frame land before hanging up.
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  // Advance far enough that any bound the runner kept would fire, so a runner
  // that failed to release the turn is reported rather than hung on.
  const settled = await Promise.race([
    turn.then((value) => ({ value }), (error) => ({ error })),
    advanceClock(t, 200_000).then(() => 'still-waiting'),
  ]);

  assert.notEqual(settled, 'still-waiting', 'a cancelled turn is not held for a later verdict');
  assert.equal(settled.error, undefined, `a cancelled turn does not end as an error: ${settled.error?.message}`);
  assert.equal(settled.value?.aborted, true, 'a cancelled turn settles as aborted');
  // Proof the turn was genuinely live on the reply stream when the caller hung
  // up, so the release above is a cancellation and not a turn that never ran.
  assert.deepEqual(deltas, ['working on it']);
  assert.equal(
    getEventListeners(caller.signal, 'abort').length,
    0,
    'the runner leaves no abort listener behind on the caller signal',
  );
  assert.ok(
    !stages.some((stage) => stage.stage === 'turn.stalled'),
    'a cancelled turn is not later reported as stalled',
  );
});

// The feed is opened before the prompt goes out, and that wait is bounded by the
// feed's own window rather than by the caller's patience. A phone that hangs up
// while the GET is still opening has to be released at once, like every other
// wait here: sitting out the window holds a device slot the freed call is
// waiting for, and blames a turn on a feed it had already left.
test('a caller that hangs up while the event feed is opening is released at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const seen = collector();
  const stages = [];
  let sent = false;
  const backend = {
    streamEvents(_sessionId, _onEvent, signal) {
      const done = new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      // The feed's GET never answers, so the runner parks on readiness rather
      // than on the backend turn.
      done.ready = new Promise(() => {});
      return done;
    },
    async sendMessage() {
      sent = true;
      return { text: 'never asked' };
    },
  };

  const caller = new AbortController();
  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    ...seen.handlers,
    onStage: (detail) => stages.push(detail),
    signal: caller.signal,
  });
  // Let the runner reach the feed wait before hanging up.
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  // Well past the feed's own open window: a runner that waits it out is
  // reported rather than hung on.
  const settled = await Promise.race([
    turn.then((value) => ({ value }), (error) => ({ error })),
    advanceClock(t, 20_000).then(() => 'still-waiting'),
  ]);

  assert.notEqual(settled, 'still-waiting', 'the caller leaving releases the feed wait');
  assert.equal(settled.error, undefined, `a cancelled turn does not end as an error: ${settled.error?.message}`);
  assert.equal(settled.value?.aborted, true, 'the turn settles as aborted');
  assert.equal(sent, false, 'a turn the caller left is never sent to the backend');
  assert.ok(
    !stages.some((stage) => stage.stage === 'feed.unavailable'),
    'a turn the caller left is not blamed on a feed it never used',
  );
  assert.equal(
    seen.chunks.filter((chunk) => JSON.parse(chunk).telemetry?.status === 'degraded').length,
    0,
    'no degraded-telemetry warning is sent for a turn the caller left',
  );
  assert.equal(
    getEventListeners(caller.signal, 'abort').length,
    0,
    'the runner leaves no abort listener behind on the caller signal',
  );
});
