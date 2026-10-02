import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCODE_FIRST_OUTPUT_IDLE_MS,
  OPENCODE_IDLE_MS,
  createOpenCodeBackend,
  createOpenCodePartTracker,
  normalizeOpenCodeEvent,
  toGatewaySession,
  toGatewayMessage,
} from '../core/cli-environments/backends/opencode.mjs';
import { opencodeAdapter } from '../core/cli-environments/adapters/opencode.mjs';

// Shapes captured live from opencode 1.18.18 — see docs/opencode-backend-contract.md.
const SESSION = {
  id: 'ses_abc',
  title: 'Repo cleanup',
  directory: 'C:\\Projects\\Versutus',
  parentID: null,
  time: { created: 1786000000000, updated: 1786000500000 },
  tokens: { input: 120, output: 340, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0.0021,
};

function stubFetch(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      const handler = routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path];
      if (!handler) return { ok: false, status: 404, async text() { return 'not found'; } };
      const value = typeof handler === 'function' ? handler() : handler;
      return { ok: true, status: 200, async json() { return value; }, async text() { return JSON.stringify(value); } };
    },
  };
}

test('sessions map onto the shape the app already parses', () => {
  const mapped = toGatewaySession(SESSION);
  assert.equal(mapped.id, 'ses_abc');
  assert.equal(mapped.title, 'Repo cleanup');
  assert.equal(mapped.source, 'opencode');
  assert.equal(mapped.started_at, SESSION.time.created);
  assert.equal(mapped.last_active, SESSION.time.updated);
  assert.equal(mapped.input_tokens, 120);
  assert.equal(mapped.output_tokens, 340);
  assert.equal(mapped.parent_session_id, null);
  assert.equal(mapped.ended_at, null);
  // Fields the app reads but OpenCode has no notion of must still be present.
  for (const key of ['message_count', 'tool_call_count', 'api_call_count', 'cache_read_tokens']) {
    assert.equal(typeof mapped[key], 'number', `${key} must be a number`);
  }
});

test('a parts-based message becomes content the app can render', () => {
  const mapped = toGatewayMessage({
    info: { id: 'msg_1', role: 'assistant', time: { created: 1786000000000 } },
    parts: [
      { type: 'step-start' },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'step-finish' },
    ],
  });
  assert.equal(mapped.id, 'msg_1');
  assert.equal(mapped.role, 'assistant');
  assert.deepEqual(mapped.content, [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }]);
  assert.equal(mapped.timestamp, 1786000000000);
});

test('a tool part is surfaced as a tool call, not dropped', () => {
  const mapped = toGatewayMessage({
    info: { id: 'msg_2', role: 'assistant', time: { created: 1 } },
    parts: [{ type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed' } }],
  });
  assert.equal(mapped.tool_calls?.length, 1);
  assert.equal(mapped.tool_calls[0].name, 'read');
});

// ─── event normalization ───────────────────────────────────────────
// Only the events opencode actually emits. The spec's `session.next.*` family
// never fires on 1.18.x, so mapping it would produce a silent no-op adapter.

test('a text delta becomes message.delta', () => {
  const event = normalizeOpenCodeEvent({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'hi' },
  });
  assert.equal(event.type, 'message.delta');
  assert.equal(event.payload.text, 'hi');
});

test('a reasoning delta becomes thinking rather than answer text', () => {
  const event = normalizeOpenCodeEvent({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', field: 'reasoning', delta: 'thinking' },
  });
  assert.equal(event?.type, 'message.reasoning.delta');
  assert.equal(event?.payload.text, 'thinking');
});

// 1.18.18 streams both answers and thoughts as `field:'text'`; the part's own
// `type` (announced on message.part.updated) is the only thing that tells them
// apart. Routing on `field` alone turns a thought into the answer.
test('a field:text delta is routed by the type of the part it names', () => {
  const tracker = createOpenCodePartTracker();
  tracker.remember({ id: 'prt_r', type: 'reasoning' });
  tracker.remember({ id: 'prt_t', type: 'text' });

  const thought = normalizeOpenCodeEvent({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_r', field: 'text', delta: 'weigh it' },
  }, tracker);
  assert.equal(thought?.type, 'message.reasoning.delta');
  assert.equal(thought?.payload.text, 'weigh it');

  const answer = normalizeOpenCodeEvent({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'the answer' },
  }, tracker);
  assert.equal(answer?.type, 'message.delta');
  assert.equal(answer?.payload.text, 'the answer');
});

function collectEvents(events) {
  const encoder = new TextEncoder();
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
          controller.close();
        },
      }),
    }),
  });
  const seen = [];
  return backend.streamEvents('ses_abc', (event) => seen.push(event)).then(() => seen);
}

// The bus does not name the session in one place: a real `message.part.updated`
// carries it on the envelope, on the part, or on both. A fixture that invents
// both ids hides whether the nested one is honoured, so this one carries the
// envelope only and the part has to be routed from it.
const partUpdated = (part) => ({
  type: 'message.part.updated',
  properties: { sessionID: 'ses_abc', part: { messageID: 'm', ...part } },
});

/** The other shape a real part update takes: session named on the part only. */
const nestedPartUpdated = (sessionId, part) => ({
  type: 'message.part.updated',
  properties: { part: { sessionID: sessionId, messageID: 'm', ...part } },
});

test('metadata arriving after the delta still keeps the thought out of the answer', async () => {
  const seen = await collectEvents([
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_r', field: 'text', delta: 'deep' } },
    partUpdated({ id: 'prt_r', type: 'reasoning', text: 'deep' }),
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['message.reasoning.delta', 'run.completed']);
  assert.equal(seen[0].payload.text, 'deep');
});

test('the closing full-text snapshot is not replayed over the deltas', async () => {
  const seen = await collectEvents([
    partUpdated({ id: 'prt_t', type: 'text', text: '' }),
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'Hel' } },
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'lo' } },
    partUpdated({ id: 'prt_t', type: 'text', text: 'Hello' }),
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['message.delta', 'message.delta', 'run.completed']);
  assert.equal(seen.filter((event) => event.type === 'message.delta').map((event) => event.payload.text).join(''), 'Hello');
});

test('a snapshot forwards only the tail the deltas have not already sent', async () => {
  const seen = await collectEvents([
    partUpdated({ id: 'prt_t', type: 'text', text: '' }),
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'Hello' } },
    partUpdated({ id: 'prt_t', type: 'text', text: 'Hello world' }),
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.equal(seen.filter((event) => event.type === 'message.delta').map((event) => event.payload.text).join(''), 'Hello world');
});

// ─── terminal safety boundary ──────────────────────────────────────
// If a part's type never arrives, its buffered `field:'text'` deltas could be
// a thought. The stream must not classify them as the answer, and must not
// report completion over the omission — identifiers and counts only.

test('a terminal event never turns unclassifiable buffered text into an answer', async () => {
  const seen = await collectEvents([
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_u', field: 'text', delta: 'a private thought' } },
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_u', field: 'text', delta: 'still private' } },
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_v', field: 'text', delta: 'also untyped' } },
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['diagnostic', 'run.failed']);
  assert.equal(seen.filter((event) => event.type === 'message.delta').length, 0);
  assert.deepEqual(seen[0].payload.partIds, ['prt_u', 'prt_v']);
  assert.equal(seen[0].payload.partCount, 2);
  assert.equal(seen[0].payload.deltaCount, 3);
  assert.ok(!JSON.stringify(seen).includes('private thought'), 'no buffered text may leak into the diagnostic');
  assert.ok(!JSON.stringify(seen).includes('still private'));
  assert.ok(!JSON.stringify(seen).includes('also untyped'));
});

test('a typed part and a legacy bare delta still complete normally at the terminal event', async () => {
  const seen = await collectEvents([
    partUpdated({ id: 'prt_t', type: 'text', text: '' }),
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'answer' } },
    // Legacy shapes carry no part id at all, so nothing is buffered for them.
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', field: 'text', delta: ' bare' } },
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['message.delta', 'message.delta', 'run.completed']);
  assert.equal(seen.map((event) => event.payload.text).join(''), 'answer bare');
});

// ─── bounded metadata recovery ─────────────────────────────────────
// A part's type normally arrives on `message.part.updated`, but if that frame
// is lost the held `field:'text'` deltas can name their message and part, and
// the message route already returns every part. One bounded lookup recovers the
// type and releases the text to the right channel — without ever guessing.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForEvent(seen, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = seen.find((event) => event.type === type);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${type}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** A backend whose /event stream stays open until the test sends or closes it. */
function liveBackend(routes = {}, options = {}) {
  const encoder = new TextEncoder();
  let streamController;
  let closed = false;
  const calls = [];
  const send = (event) => {
    try {
      streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      // The subscriber has let the stream go — the turn's own bound fired and
      // closed it — so this frame is published to nobody. Same rule as the
      // `broadcast` helper below and as a real bus: a frame nobody is reading is
      // gone, not a `ERR_INVALID_STATE` out of the fixture. Without this the
      // test that drives a bound to expiry fails for the fixture's reason rather
      // than its own, and only when the suite's load stretches its `delay`s
      // enough for the bound to land mid-loop.
    }
  };
  // The server's side of the bus: a frame published with nobody subscribed is
  // gone, exactly as it is on a real OpenCode server.
  const broadcast = (event) => { if (streamController) send(event); };
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    ...options,
    fetchImpl: async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      if (path === '/event') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({ start(controller) { streamController = controller; } }),
        };
      }
      const handler = routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path];
      if (!handler) return { ok: false, status: 404, async text() { return 'not found'; } };
      // A route may act as the server while it answers — broadcast a bus frame,
      // read a clock — which is how a turn that ends before the send is answered
      // is reproduced.
      const value = typeof handler === 'function'
        ? await handler(init, { send, broadcast })
        : handler;
      return { ok: true, status: 200, async json() { return value; }, async text() { return JSON.stringify(value); } };
    },
  });
  return {
    backend,
    calls,
    /** True once a subscriber is attached to the bus this fixture feeds. */
    opened: () => Boolean(streamController),
    send,
    // The server's side of the bus: a frame published with nobody subscribed is
    // gone, exactly as it is on a real OpenCode server.
    broadcast,
    // One chunk carrying several frames, so a callback that aborts mid-batch
    // really does land with lines still queued behind it.
    sendAll: (...events) => streamController.enqueue(
      encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
    ),
    close: () => { if (!closed) { closed = true; streamController.close(); } },
  };
}

const unknownTextDelta = (partId, delta) => ({
  type: 'message.part.delta',
  properties: { sessionID: 'ses_abc', messageID: 'm', partID: partId, field: 'text', delta },
});

test('an untyped text delta recovers its reasoning type over the message route before any terminal', async () => {
  const lookedUp = [];
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => {
      lookedUp.push('m');
      return { info: { id: 'm' }, parts: [{ id: 'u', type: 'reasoning', text: 'deep' }] };
    },
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'deep'));
  const recovered = await waitForEvent(seen, 'message.reasoning.delta');
  assert.ok(
    !seen.some((event) => event.type === 'run.completed' || event.type === 'run.failed'),
    'the thought must be recovered live, not only at the terminal',
  );
  assert.equal(recovered.payload.text, 'deep');
  assert.deepEqual(lookedUp, ['m']);
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
});

test('an untyped text delta recovers its answer type over the message route', async () => {
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => ({
      info: { id: 'm' },
      parts: [{ id: 'u', type: 'text', text: 'the answer' }],
    }),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'the answer'));
  const recovered = await waitForEvent(seen, 'message.delta');
  assert.equal(recovered.payload.text, 'the answer');
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
});

// The message route returns the *whole* part, not only the deltas that had
// already streamed, so recovering the type has to release all of it. Holding
// the text back here loses the tail when no closing snapshot ever follows.
test('recovery releases the recovered part in full, not only the deltas it had queued', async () => {
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => ({
      info: { id: 'm', sessionID: 'ses_abc' },
      parts: [{ id: 'u', type: 'text', text: 'Hello world', messageID: 'm', sessionID: 'ses_abc' }],
    }),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'Hello '));
  // No `message.part.updated` follows: the idle is the terminal event.
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  const answer = seen.filter((event) => event.type === 'message.delta')
    .map((event) => event.payload.text).join('');
  assert.equal(answer, 'Hello world');
  for (const event of seen.filter((event) => event.type === 'message.delta')) {
    assert.equal(event.payload.sessionId, 'ses_abc');
    assert.equal(event.payload.partId, 'u');
  }
  assert.equal(seen.filter((event) => event.type === 'run.completed').length, 1);
  assert.equal(seen[seen.length - 1].type, 'run.completed');
});

// A recovered snapshot can be older than the deltas already queued for the
// part, so it must never supersede them: the queued text is normalized first
// and the snapshot only contributes the suffix the deltas did not send.
test('a shorter recovered snapshot never supersedes a queued delta', async () => {
  let releaseLookup;
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => new Promise((resolve) => {
      releaseLookup = () => resolve({
        info: { id: 'm' },
        parts: [{ id: 'u', type: 'text', text: 'Hello ' }],
      });
    }),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'Hello world'));
  // The idle lands while the lookup is still in flight, so the shorter
  // snapshot is only reconciled in the terminal pass.
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await delay(10);
  releaseLookup();
  await stream;
  const answer = seen.filter((event) => event.type === 'message.delta')
    .map((event) => event.payload.text).join('');
  assert.equal(answer, 'Hello world');
  assert.equal(seen.filter((event) => event.type === 'run.completed').length, 1);
  assert.ok(!seen.some((event) => event.type === 'message.reasoning.delta'), 'a thought must not surface as the answer');
});

// A lookup answers for one message of one session. A response that reuses this
// session's part id but belongs to another session (or another message) is not
// this turn's data, and must be refused before it reaches the part tracker, the
// held queue or the client — including a part the stream already typed.
test('a lookup answering for a foreign session is refused before it publishes anything', async () => {
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => ({
      info: { id: 'm', sessionID: 'ses_other' },
      parts: [{ id: 'u', type: 'text', text: 'a stranger answer', messageID: 'm', sessionID: 'ses_other' }],
    }),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'a private thought'));
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  assert.equal(seen.filter((event) => event.type === 'message.delta').length, 0);
  assert.deepEqual(seen.map((event) => event.type), ['diagnostic', 'run.failed']);
  assert.deepEqual(seen[0].payload.partIds, ['u']);
  assert.ok(!JSON.stringify(seen).includes('a stranger answer'), 'a foreign body must never leak');
});

test('a lookup answering for another message is refused, and a part may not be claimed by one', async () => {
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => ({
      info: { id: 'm2' },
      parts: [
        { id: 'u', type: 'text', text: 'a stranger answer', messageID: 'm2' },
        { id: 'w', type: 'text', text: 'also a stranger', sessionID: 'ses_abc', messageID: 'm2' },
      ],
    }),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'held'));
  send(unknownTextDelta('w', 'held too'));
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  assert.equal(seen.filter((event) => event.type === 'message.delta').length, 0);
  assert.deepEqual(seen.map((event) => event.type), ['diagnostic', 'run.failed']);
  assert.deepEqual(seen[0].payload.partIds, ['u', 'w']);
  assert.ok(!JSON.stringify(seen).includes('stranger'));
});

test('one lookup per message recovers every held part it names', async () => {
  let lookups = 0;
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => {
      lookups += 1;
      return {
        info: { id: 'm' },
        parts: [{ id: 'u', type: 'reasoning', text: 'think' }, { id: 'w', type: 'text', text: 'answer' }],
      };
    },
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'think'));
  send(unknownTextDelta('w', 'answer'));
  await waitForEvent(seen, 'message.delta');
  assert.deepEqual(seen.map((event) => event.type), ['message.reasoning.delta', 'message.delta']);
  assert.equal(lookups, 1, 'a second held part in the same message must reuse the one lookup');
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
});

test('a late metadata snapshot adds only the suffix the recovered deltas have not sent', async () => {
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => ({
      info: { id: 'm' },
      parts: [{ id: 'u', type: 'text', text: 'Hello world' }],
    }),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'Hello '));
  await waitForEvent(seen, 'message.delta');
  // The real closing snapshot arrives after recovery with the full text.
  send({ type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { id: 'u', type: 'text', text: 'Hello world', messageID: 'm' } } });
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  const answer = seen.filter((event) => event.type === 'message.delta').map((event) => event.payload.text).join('');
  assert.equal(answer, 'Hello world');
});

test('part metadata that arrives while the recovery lookup is in flight wins', async () => {
  let releaseLookup;
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => new Promise((resolve) => {
      releaseLookup = () => resolve({ info: { id: 'm' }, parts: [{ id: 'u', type: 'text', text: 'deep' }] });
    }),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  // The role lives only on `message.updated`, so the fixture has to say who
  // wrote message 'm' before its parts are published at all.
  send({ type: 'message.updated', properties: { info: { id: 'm', role: 'assistant', sessionID: 'ses_abc' } } });
  send(unknownTextDelta('u', 'deep'));
  // Metadata beats the lookup: the part is a thought, not the answer.
  send({ type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { id: 'u', type: 'reasoning', text: 'deep', messageID: 'm' } } });
  const reasoning = await waitForEvent(seen, 'message.reasoning.delta');
  assert.equal(reasoning.payload.text, 'deep');
  releaseLookup();
  await delay(30);
  assert.equal(seen.filter((event) => event.type === 'message.delta').length, 0, 'the losing lookup must not reclassify');
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
});

test('a lookup that never answers cannot stall the terminal, which reports the unclassified delta', async () => {
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => new Promise(() => {}),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(unknownTextDelta('u', 'a private thought'));
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  const started = Date.now();
  await stream;
  assert.ok(Date.now() - started < 2500, 'a dead lookup must be bounded, not hang the stream');
  assert.deepEqual(seen.map((event) => event.type), ['diagnostic', 'run.failed']);
  assert.ok(!JSON.stringify(seen).includes('a private thought'));
});

test('abort settles promptly while a lookup is in flight and its late result cannot emit', async () => {
  let lookupRequested;
  const lookupStarted = new Promise((resolve) => { lookupRequested = resolve; });
  let releaseLookup;
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => new Promise((resolve) => {
      lookupRequested();
      releaseLookup = () => resolve({ info: { id: 'm' }, parts: [{ id: 'u', type: 'text', text: 'the answer' }] });
    }),
  });
  const seen = [];
  const controller = new AbortController();
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event), controller.signal);
  await stream.ready;
  send(unknownTextDelta('u', 'the answer'));
  await lookupStarted;
  controller.abort();
  const started = Date.now();
  await stream;
  assert.ok(Date.now() - started < 1000, 'abort must not wait on the lookup or the read');
  assert.equal(seen.filter((event) => event.type === 'message.delta').length, 0);
  releaseLookup?.();
  await delay(30);
  assert.equal(seen.length, 0, 'a lookup resolving after abort must stay silent');
});

/** A stream whose reader ignores its signal: `read` and `cancel` never settle. */
function stubbornBackend(firstChunk, routes = {}) {
  const encoder = new TextEncoder();
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      if (path === '/event') {
        let reads = 0;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: () => (reads++ === 0
                ? Promise.resolve({ done: false, value: encoder.encode(firstChunk) })
                : new Promise(() => {})),
              cancel: () => new Promise(() => {}),
            }),
          },
        };
      }
      const handler = routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path];
      if (!handler) return { ok: false, status: 404, async text() { return 'not found'; } };
      const value = typeof handler === 'function' ? await handler(init) : handler;
      return { ok: true, status: 200, async json() { return value; }, async text() { return JSON.stringify(value); } };
    },
  });
  return backend;
}

test('an abort raised by the first callback of a batch silences the rest of that batch', async () => {
  const { backend, sendAll } = liveBackend({});
  const seen = [];
  const controller = new AbortController();
  const stream = backend.streamEvents('ses_abc', (event) => {
    seen.push(event);
    // The client leaves the moment it has its answer: the lines still queued
    // behind this one in the same read must not reach it.
    controller.abort();
  }, controller.signal);
  await stream.ready;
  sendAll(
    partUpdated({ id: 'prt_t', type: 'text', text: '' }),
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'first' } },
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'second' } },
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  );
  const settled = await Promise.race([stream.then(() => 'settled'), delay(1500).then(() => 'hung')]);
  assert.equal(settled, 'settled', 'abort must settle the stream mid-batch');
  assert.deepEqual(seen.map((event) => event.type), ['message.delta']);
  assert.equal(seen[0].payload.text, 'first');
});

// The terminal pass settles the deferred lookup and then flushes the held text;
// a callback that aborts on that flush must also silence the completion the
// terminal branch emits right behind it, not just the frames still queued.
test('an abort inside the terminal queued flush suppresses the completion behind it', async () => {
  let lookupRequested;
  const lookupStarted = new Promise((resolve) => { lookupRequested = resolve; });
  let releaseLookup;
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/m': () => new Promise((resolve) => {
      lookupRequested();
      releaseLookup = () => resolve({
        info: { id: 'm', sessionID: 'ses_abc' },
        parts: [{ id: 'u', type: 'text', text: 'the answer', messageID: 'm', sessionID: 'ses_abc' }],
      });
    }),
  });
  const seen = [];
  const controller = new AbortController();
  const stream = backend.streamEvents('ses_abc', (event) => {
    seen.push(event);
    // The client leaves the moment its answer lands, even though it arrives
    // during the terminal flush and a completion frame follows it.
    if (event.type === 'message.delta') controller.abort();
  }, controller.signal);
  await stream.ready;
  send(unknownTextDelta('u', 'the answer'));
  await lookupStarted;
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  // Let the terminal branch mark the lookup pending before it answers, so the
  // delta is released by the terminal flush rather than the live lookup.
  await delay(20);
  releaseLookup();
  const settled = await Promise.race([stream.then(() => 'settled'), delay(1500).then(() => 'hung')]);
  assert.equal(settled, 'settled', 'the terminal queued flush must settle');
  assert.deepEqual(seen.map((event) => event.type), ['message.delta']);
  assert.equal(seen[0].payload.text, 'the answer');
});

// `tool.output` first flushes a suppressed `tool.progress` in the same frame; a
// callback that aborts on that progress must silence the output behind it.
test('an abort inside the tool-output pending flush suppresses the output behind it', async () => {
  const { backend, sendAll } = liveBackend({});
  const seen = [];
  const controller = new AbortController();
  const stream = backend.streamEvents('ses_abc', (event) => {
    seen.push(event);
    if (event.type === 'tool.progress') controller.abort();
  }, controller.signal);
  await stream.ready;
  sendAll(
    partUpdated({ type: 'tool', tool: 'exec', callID: 'c9', state: { status: 'pending', input: { command: 'g' } } }),
    partUpdated({ type: 'tool', tool: 'exec', callID: 'c9', state: { status: 'running', input: { command: 'git status' } } }),
    partUpdated({ type: 'tool', tool: 'exec', callID: 'c9', state: { status: 'completed', output: 'clean' } }),
  );
  const settled = await Promise.race([stream.then(() => 'settled'), delay(1500).then(() => 'hung')]);
  assert.equal(settled, 'settled', 'the tool-output flush must settle');
  assert.deepEqual(seen.map((event) => event.type), ['tool.started', 'tool.progress']);
});

test('an abort settles while the reader, its cancel and the recovery lookup all ignore the signal', async () => {
  let lookupRequested;
  const lookupStarted = new Promise((resolve) => { lookupRequested = resolve; });
  let releaseLookup;
  const backend = stubbornBackend(
    `data: ${JSON.stringify(unknownTextDelta('u', 'the answer'))}\n\ndata: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_abc' } })}\n\n`,
    {
      'GET /session/ses_abc/message/m': () => new Promise((resolve) => {
        lookupRequested();
        releaseLookup = () => resolve({
          info: { id: 'm', sessionID: 'ses_abc' },
          parts: [{ id: 'u', type: 'text', text: 'the answer', messageID: 'm', sessionID: 'ses_abc' }],
        });
      }),
    },
  );
  const seen = [];
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const controller = new AbortController();
  try {
    const stream = backend.streamEvents('ses_abc', (event) => seen.push(event), controller.signal);
    await stream.ready;
    // The terminal frame is already waiting on that lookup when the abort lands.
    const began = await Promise.race([
      lookupStarted.then(() => 'started'),
      delay(1500).then(() => 'never-started'),
    ]);
    assert.equal(began, 'started', 'the fixture must reach the terminal lookup before the abort');
    const started = Date.now();
    controller.abort();
    const settled = await Promise.race([stream.then(() => 'settled'), delay(1500).then(() => 'hung')]);
    assert.equal(settled, 'settled', 'abort must not wait on a lookup, a read or a cancel that ignore it');
    assert.ok(Date.now() - started < 1000, 'abort settles on the signal, not on the cleanup bound');
    assert.equal(seen.length, 0, 'no frame may follow the signal, including the terminal one');
    releaseLookup?.();
    await delay(60);
    assert.equal(seen.length, 0, 'a lookup resolving after abort must stay silent');
    assert.deepEqual(rejections, [], 'a late lookup must not surface as a rejection');
  } finally {
    // Bound the old failure path: abort even if the assertions threw, so the
    // stream cannot outlive the test and leak reads into the next one.
    controller.abort();
    releaseLookup?.();
    process.off('unhandledRejection', onRejection);
  }
});

// ─── whose text is the answer ───────────────────────────────────────
// The operator's own prompt is a `text` part of a `role:'user'` message on the
// same session, and nothing in the streamed-part path used to look at the role.
// Forwarding it glues the operator's words in front of the reply — reported from
// a phone on 2026-10-01 as `Hey budHey! What are we working on?`. The role is
// only on `message.updated`, and the bus does not promise it lands first.

/** A real message update: `info.id` and `info.role` are the only role carrier. */
const messageUpdated = (id, role) => ({
  type: 'message.updated',
  properties: { info: { id, role, sessionID: 'ses_abc' } },
});

test("the operator's own prompt is never published as the answer", async () => {
  const seen = await collectEvents([
    messageUpdated('msg_u', 'user'),
    // The prompt's parts: a snapshot of its text and the thought stream beside
    // it. Both belong to a message that is not the assistant's.
    partUpdated({ id: 'prt_u', type: 'text', text: 'Hey bud', messageID: 'msg_u' }),
    partUpdated({ id: 'prt_r_u', type: 'reasoning', text: 'be warm', messageID: 'msg_u' }),
    messageUpdated('msg_a', 'assistant'),
    partUpdated({ id: 'prt_a', type: 'text', text: '', messageID: 'msg_a' }),
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'msg_a', partID: 'prt_a', field: 'text', delta: 'Hey! What are we working on?' } },
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  const answer = seen.filter((event) => event.type === 'message.delta').map((event) => event.payload.text).join('');
  assert.equal(answer, 'Hey! What are we working on?');
  assert.equal(seen.filter((event) => event.type === 'message.reasoning.delta').length, 0);
  assert.ok(!JSON.stringify(seen).includes('Hey bud'), "the operator's prompt must not reach the client");
  assert.ok(!JSON.stringify(seen).includes('be warm'), "the operator's own reasoning must not reach the client");
});

test("a prompt streamed before its message's role is still not published", async () => {
  // No lookup can answer here, so the late `message.updated` is the only thing
  // that can drop the prompt: bus order alone must never publish it.
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/msg_u': () => new Promise(() => {}),
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', messageID: 'msg_u', partID: 'prt_u', field: 'text', delta: 'Hey bud' },
  });
  send(partUpdated({ id: 'prt_u', type: 'text', text: 'Hey bud', messageID: 'msg_u' }));
  // Only now does the turn say who wrote that message.
  send(messageUpdated('msg_u', 'user'));
  send(messageUpdated('msg_a', 'assistant'));
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  assert.equal(seen.filter((event) => event.type === 'message.delta').length, 0);
  assert.deepEqual(seen.map((event) => event.type).slice(-1), ['run.completed']);
  assert.ok(!JSON.stringify(seen).includes('Hey bud'), "the operator's prompt must not reach the client");
});

test('the bounded message lookup settles a prompt whose message.updated never arrives', async () => {
  let lookups = 0;
  // The message route answers for the prompt itself: same part, same text, and
  // the role that says it is not this turn's answer.
  const { backend, send } = liveBackend({
    'GET /session/ses_abc/message/msg_u': () => {
      lookups += 1;
      return {
        info: { id: 'msg_u', role: 'user', sessionID: 'ses_abc' },
        parts: [{ id: 'prt_p', type: 'text', text: 'a private prompt', messageID: 'msg_u', sessionID: 'ses_abc' }],
      };
    },
  });
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', messageID: 'msg_u', partID: 'prt_p', field: 'text', delta: 'a private prompt' },
  });
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  assert.equal(lookups, 1, 'the held part must ask for its role exactly once');
  assert.equal(seen.filter((event) => event.type === 'message.delta').length, 0);
  assert.ok(!JSON.stringify(seen).includes('a private prompt'));
});

test('an assistant part held for its role is published once, as soon as the role lands', async () => {
  const { backend, send } = liveBackend({});
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', messageID: 'msg_a', partID: 'prt_a', field: 'text', delta: 'Hello ' },
  });
  send({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', messageID: 'msg_a', partID: 'prt_a', field: 'text', delta: 'there' },
  });
  send(partUpdated({ id: 'prt_a', type: 'text', text: 'Hello there', messageID: 'msg_a' }));
  // Nothing may go out before the role is known: this text could be a prompt.
  await delay(30);
  assert.deepEqual(seen, [], 'answer text must not leave before its role is known');
  send(messageUpdated('msg_a', 'assistant'));
  await waitForEvent(seen, 'message.delta');
  // Two frames for two deltas, in order, and the closing snapshot adds nothing.
  assert.deepEqual(seen.filter((event) => event.type === 'message.delta').map((event) => event.payload.text), ['Hello ', 'there']);
  // The closing snapshot must not be replayed over what already went out.
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  assert.equal(seen.filter((event) => event.type === 'message.delta').map((event) => event.payload.text).join(''), 'Hello there');
});

// ─── session isolation ─────────────────────────────────────────────
// The event bus is shared by every session on the server, and a part id is
// only unique within one of them. A foreign event that reuses this session's
// part or call id must never reach the caches that decide what is reasoning,
// what is answer text, and what has already been emitted.

// A real part update can name the session on the part alone; that metadata is
// this session's own and must still arrive, routing the held delta and
// reporting this session as the frame's identity.
test('part metadata naming the session only on the part is honoured', async () => {
  const seen = await collectEvents([
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_r', field: 'text', delta: 'deep' } },
    nestedPartUpdated('ses_abc', { id: 'prt_r', type: 'reasoning', text: 'deep' }),
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['message.reasoning.delta', 'run.completed']);
  assert.equal(seen[0].payload.text, 'deep');
  assert.equal(seen[0].payload.sessionId, 'ses_abc');
});

test("another session's part cannot claim this session's part id type", async () => {
  const seen = await collectEvents([
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_x', field: 'text', delta: 'mine' } },
    // Same part id, other session: if this lands in the tracker it decides the
    // type of our delta and the thought is emitted as the answer.
    nestedPartUpdated('ses_other', { id: 'prt_x', type: 'text', text: 'mine' }),
    nestedPartUpdated('ses_abc', { id: 'prt_x', type: 'reasoning', text: 'mine' }),
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['message.reasoning.delta', 'run.completed']);
  assert.equal(seen[0].payload.text, 'mine');
});

test("another session's snapshot cannot extend this session's part text", async () => {
  const seen = await collectEvents([
    partUpdated({ id: 'prt_t', type: 'text', text: '' }),
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'mine' } },
    nestedPartUpdated('ses_other', { id: 'prt_t', type: 'text', text: 'mine and theirs' }),
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['message.delta', 'run.completed']);
  assert.equal(seen[0].payload.text, 'mine');
  assert.equal(seen[0].payload.sessionId, 'ses_abc');
});

test("another session's tool part cannot emit its failure under this session's call id", async () => {
  const seen = await collectEvents([
    { type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'pending', input: { file_path: 'A' } } } } },
    nestedPartUpdated('ses_other', { type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'error', error: 'their secret' } }),
    { type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'completed', output: 'our file' } } } },
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['tool.started', 'tool.output', 'run.completed']);
  assert.equal(seen[1].payload.output, 'our file');
  assert.ok(!JSON.stringify(seen).includes('their secret'), 'a foreign tool failure must not reach the client');
});

// An envelope and a part that disagree cannot both be this session, and the
// safe reading is neither. An event that names no session at all is left
// alone, so the legacy shapes the app already maps keep flowing.
test('a session identity that contradicts itself is refused, a session-less one still flows', async () => {
  const seen = await collectEvents([
    { type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { sessionID: 'ses_other', type: 'text', id: 'prt_t', text: 'whose is it' } } },
    { type: 'lsp.updated', properties: { file: 'a.ts' } },
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['diagnostic', 'run.completed']);
  assert.ok(!JSON.stringify(seen).includes('whose is it'));
});

// A real `message.updated` names its session on `properties.info` and nowhere
// else. That identity is the one the envelope has to honour: a foreign
// message's tokens must never arrive as this session's usage, and an adopted
// one must be billed to the session it actually names rather than to nobody.
test('a message update is scoped by the session its info envelope names', async () => {
  const message = (info, sessionID) => ({ type: 'message.updated', properties: { info, ...(sessionID ? { sessionID } : {}) } });
  const seen = await collectEvents([
    message({ id: 'msg_foreign', sessionID: 'ses_other', tokens: { input: 9 }, cost: 1 }),
    message({ id: 'msg_own', sessionID: 'ses_abc', tokens: { input: 3 }, cost: 2 }),
    message({ id: 'msg_clash_a', sessionID: 'ses_other', tokens: { input: 7 } }, 'ses_abc'),
    message({ id: 'msg_clash_b', sessionID: 'ses_abc', tokens: { input: 8 } }, 'ses_other'),
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
  ]);
  assert.deepEqual(seen.map((event) => event.type), ['usage', 'run.completed']);
  assert.deepEqual(seen[0].payload, { sessionId: 'ses_abc', tokens: { input: 3 }, cost: 2 });
  const emitted = JSON.stringify(seen);
  assert.ok(!emitted.includes('ses_other'), 'no foreign or self-contradicting identity may reach the client');
  for (const id of ['msg_foreign', 'msg_clash_a', 'msg_clash_b']) {
    assert.ok(!emitted.includes(id), `a refused message (${id}) must leave nothing behind`);
  }
});

test('simultaneous subscriptions keep their own part caches', async () => {
  const encoder = new TextEncoder();
  const lines = [
    { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'm', partID: 'prt_x', field: 'text', delta: 'alpha' } },
    nestedPartUpdated('ses_abc', { id: 'prt_x', type: 'reasoning', text: 'alpha' }),
    { type: 'message.part.delta', properties: { sessionID: 'ses_xyz', messageID: 'm', partID: 'prt_x', field: 'text', delta: 'beta' } },
    nestedPartUpdated('ses_xyz', { id: 'prt_x', type: 'text', text: 'beta' }),
    { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
    { type: 'session.idle', properties: { sessionID: 'ses_xyz' } },
  ];
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(lines.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
          controller.close();
        },
      }),
    }),
  });
  const mine = [];
  const theirs = [];

  await Promise.all([
    backend.streamEvents('ses_abc', (event) => mine.push(event)),
    backend.streamEvents('ses_xyz', (event) => theirs.push(event)),
  ]);

  // The same part id is a thought in one session and the answer in the other.
  assert.deepEqual(mine.map((event) => event.type), ['message.reasoning.delta', 'run.completed']);
  assert.equal(mine[0].payload.text, 'alpha');
  assert.equal(mine[0].payload.sessionId, 'ses_abc');
  assert.deepEqual(theirs.map((event) => event.type), ['message.delta', 'run.completed']);
  assert.equal(theirs[0].payload.text, 'beta');
  assert.equal(theirs[0].payload.sessionId, 'ses_xyz');
});

test('a failed tool keeps its state.error detail as output', () => {
  const event = normalizeOpenCodeEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_abc',
      part: { type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'error', input: {}, error: 'permission denied' } },
    },
  });
  assert.equal(event.type, 'tool.output');
  assert.equal(event.payload.status, 'error');
  assert.equal(event.payload.output, 'permission denied');
});

test('the event stream exposes when its feed is ready', async () => {
  let releaseFetch;
  let closeStream;
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: () => new Promise((resolve) => {
      releaseFetch = () => resolve({
        ok: true,
        body: new ReadableStream({ start(controller) { closeStream = () => controller.close(); } }),
      });
    }),
  });
  const controller = new AbortController();
  const stream = backend.streamEvents('ses_abc', () => {}, controller.signal);
  try {
    assert.equal(typeof stream.ready?.then, 'function');
    releaseFetch();
    await stream.ready;
  } finally {
    controller.abort();
    closeStream?.();
    releaseFetch();
    await stream;
  }
});

test('a clean event-stream EOF before a terminal event is reported as a telemetry failure', async () => {
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async () => ({
      ok: true,
      body: new ReadableStream({ start(controller) { controller.close(); } }),
    }),
  });
  const stream = backend.streamEvents('ses_abc', () => {});
  await stream.ready;
  await assert.rejects(stream, /ended before a terminal event/i);
});

test('a terminal event lets the event stream close cleanly', async () => {
  const encoder = new TextEncoder();
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"session.idle","properties":{"sessionID":"ses_abc"}}\n\n'));
          controller.close();
        },
      }),
    }),
  });
  const seen = [];
  await backend.streamEvents('ses_abc', (event) => seen.push(event));
  assert.deepEqual(seen.map((event) => event.type), ['run.completed']);
});

test('the event stream turns later pending snapshots into bounded progress without duplicates', async () => {
  const { backend, send } = liveBackend({});
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c2', state: { status: 'pending', input: { command: 'g' } } }));
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c2', state: { status: 'pending', input: { command: 'gi' } } }));
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c2', state: { status: 'pending', input: { command: 'git status' } } }));
  // The stream then stays open with no further frames. The held snapshot must
  // reach the client on the throttle deadline rather than wait for the next
  // event, which may only arrive minutes later while the tool is still running.
  const progress = await waitForEvent(seen, 'tool.progress');
  assert.deepEqual(progress.payload.input, { command: 'git status' });
  assert.equal(progress.payload.callId, 'c2');
  assert.equal(progress.payload.snapshot, true);
  assert.deepEqual(seen.map((event) => event.type), ['tool.started', 'tool.progress']);
  // The queued snapshots coalesce into that one frame; nothing repeats afterwards.
  await delay(240);
  assert.equal(seen.filter((event) => event.type === 'tool.progress').length, 1);
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c2', state: { status: 'completed', output: 'clean' } }));
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  assert.deepEqual(seen.map((event) => event.type), ['tool.started', 'tool.progress', 'tool.output', 'run.completed']);
  // Completion cancels any held progress: no delayed frame may trail the output.
  await delay(240);
  assert.equal(seen.filter((event) => event.type === 'tool.progress').length, 1);
});

test('two active tool calls hold and flush their newest snapshots independently', async () => {
  const { backend, send } = liveBackend({});
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'pending', input: { command: 'a' } } }));
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'pending', input: { command: 'aa' } } }));
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c2', state: { status: 'pending', input: { command: 'b' } } }));
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c2', state: { status: 'pending', input: { command: 'bb' } } }));
  // Each held call releases on its own deadline and carries only its own input.
  await waitForEvent(seen, 'tool.progress');
  await delay(200);
  const progress = seen.filter((event) => event.type === 'tool.progress');
  assert.deepEqual(
    Object.fromEntries(progress.map((event) => [event.payload.callId, event.payload.input])),
    { c1: { command: 'aa' }, c2: { command: 'bb' } },
  );
  // No call re-flushes: two coalesced frames, one per call, and no more.
  await delay(240);
  assert.equal(seen.filter((event) => event.type === 'tool.progress').length, 2);
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'completed', output: 'x' } }));
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c2', state: { status: 'completed', output: 'y' } }));
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
});

test('a terminal frame before the throttle deadline cancels the held progress', async () => {
  const { backend, send } = liveBackend({});
  const seen = [];
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event));
  await stream.ready;
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'pending', input: { command: 'a' } } }));
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'pending', input: { command: 'aa' } } }));
  // The turn ends while the newest input is still held: it must not surface
  // behind the terminal frame once the deadline passes.
  send({ type: 'session.idle', properties: { sessionID: 'ses_abc' } });
  await stream;
  assert.deepEqual(seen.map((event) => event.type), ['tool.started', 'run.completed']);
  await delay(240);
  assert.equal(seen.filter((event) => event.type === 'tool.progress').length, 0);
});

test('an abort before the throttle deadline cancels the held progress', async () => {
  const { backend, send } = liveBackend({});
  const seen = [];
  const controller = new AbortController();
  const stream = backend.streamEvents('ses_abc', (event) => seen.push(event), controller.signal);
  await stream.ready;
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'pending', input: { command: 'a' } } }));
  send(partUpdated({ type: 'tool', tool: 'exec', callID: 'c1', state: { status: 'pending', input: { command: 'aa' } } }));
  await waitForEvent(seen, 'tool.started');
  // Let the held snapshot arm its timer, then leave before it can fire.
  await delay(20);
  controller.abort();
  await stream;
  await delay(240);
  assert.equal(seen.filter((event) => event.type === 'tool.progress').length, 0);
});

test('a pending tool part becomes tool.started and a completed one tool.output', () => {
  const started = normalizeOpenCodeEvent({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_abc', part: { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'pending', input: { file_path: 'A' } } } },
  });
  assert.equal(started.type, 'tool.started');
  assert.equal(started.payload.name, 'read');
  assert.deepEqual(started.payload.input, { file_path: 'A' });

  const progress = normalizeOpenCodeEvent({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_abc', part: { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'running', input: { file_path: 'AGENTS.md' } } } },
  });
  assert.equal(progress.type, 'tool.progress');
  assert.equal(progress.payload.snapshot, true);
  assert.deepEqual(progress.payload.input, { file_path: 'AGENTS.md' });

  const done = normalizeOpenCodeEvent({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_abc', part: { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'completed', output: 'file contents' } } },
  });
  assert.equal(done.type, 'tool.output');
  assert.equal(done.payload.name, 'read');
});

test('a text part update is not mistaken for a tool event', () => {
  const event = normalizeOpenCodeEvent({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_abc', part: { type: 'text', text: 'hello' } },
  });
  assert.notEqual(event?.type, 'tool.started');
});

test('idle terminates the run and error fails it', () => {
  assert.equal(normalizeOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 's' } }).type, 'run.completed');
  assert.equal(
    normalizeOpenCodeEvent({ type: 'session.error', properties: { sessionID: 's', error: { name: 'Boom' } } }).type,
    'run.failed',
  );
});

test('a permission request becomes approval.required with its id', () => {
  for (const type of ['permission.asked', 'permission.v2.asked']) {
    const event = normalizeOpenCodeEvent({
      type,
      properties: { id: 'perm_1', sessionID: 's', permission: 'edit', action: 'edit', patterns: ['**/*.ts'] },
    });
    assert.equal(event.type, 'approval.required', `${type} should require approval`);
    assert.equal(event.payload.approvalId, 'perm_1');
  }
});

test('an unrecognised event is a diagnostic, never silently dropped', () => {
  const event = normalizeOpenCodeEvent({ type: 'lsp.updated', properties: { sessionID: 's' } });
  assert.equal(event.type, 'diagnostic');
});

// ─── backend surface ───────────────────────────────────────────────

test('the backend lists, creates and deletes sessions over the native API', async () => {
  const { calls, fetchImpl } = stubFetch({
    'GET /session': [SESSION],
    'POST /session': SESSION,
    'DELETE /session/ses_abc': { ok: true },
  });
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });

  const listed = await backend.listSessions();
  assert.equal(listed[0].id, 'ses_abc');
  assert.equal(listed[0].source, 'opencode');

  const created = await backend.createSession({ title: 'New' });
  assert.equal(created.id, 'ses_abc');
  assert.deepEqual(calls[1], { path: '/session', method: 'POST', body: { title: 'New' } });

  await backend.deleteSession('ses_abc');
  assert.equal(calls[2].method, 'DELETE');
});

test('models come from the native provider catalog', async () => {
  const { fetchImpl } = stubFetch({
    'GET /config/providers': {
      default: { 'opencode-go': 'gpt-5.6-luna' },
      providers: [
        { id: 'opencode-go', name: 'OpenCode Go', models: { 'gpt-5.6-luna': { name: 'Luna' } } },
        { id: 'nvidia', name: 'Nvidia', models: { 'z-ai/glm-5.2': {} } },
      ],
    },
  });
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const models = await backend.listModels();
  assert.equal(models.length, 2);
  assert.deepEqual(
    models.map((m) => m.id).sort(),
    ['opencode-go/gpt-5.6-luna', 'nvidia/z-ai/glm-5.2'].sort(),
  );
  const luna = models.find((m) => m.id === 'opencode-go/gpt-5.6-luna');
  assert.equal(luna.providerId, 'opencode-go');
  assert.equal(luna.modelId, 'gpt-5.6-luna');
});

test('sending a message posts parts and returns the assistant text', async () => {
  const { calls, fetchImpl } = stubFetch({
    'POST /session/ses_abc/message': {
      info: { id: 'msg_9', role: 'assistant', time: { created: 5 } },
      parts: [{ type: 'text', text: 'contract ok' }],
    },
  });
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const result = await backend.sendMessage('ses_abc', {
    text: 'say hi',
    model: { providerId: 'opencode-go', modelId: 'gpt-5.6-luna' },
  });
  assert.equal(result.text, 'contract ok');
  // The bus subscription is opened before the prompt, so the submitted body is
  // the POST, not the first call the server sees.
  assert.deepEqual(calls.find((call) => call.path === '/session/ses_abc/message').body, {
    model: { providerID: 'opencode-go', modelID: 'gpt-5.6-luna' },
    parts: [{ type: 'text', text: 'say hi' }],
  });
});

test('a refused send surfaces the server message', async () => {
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return JSON.stringify({ name: 'UnknownError', data: { message: 'boom' } }); } }),
  });
  await assert.rejects(() => backend.sendMessage('s', { text: 'x' }), /boom|UnknownError/);
});

test('a refused fetch rejects naming the baseUrl, not a bare fetch failed', async () => {
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(
    () => backend.sendMessage('s', { text: 'x' }),
    // The send now submits to `prompt_async`, so the route named in the reason
    // is that one (and the blocking POST only after a 404 on it).
    /opencode: could not reach http:\/\/127\.0\.0\.1:4096\/session\/s\/(prompt_async|message) \(fetch failed\)/,
  );
});

test('a 500 body-text error message stays byte-identical', async () => {
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return JSON.stringify({ name: 'UnknownError', data: { message: 'boom' } }); } }),
  });
  await assert.rejects(
    () => backend.sendMessage('s', { text: 'x' }),
    (err) => err.message === 'opencode: boom',
  );
});

// Verified live 2026-08-16: an upstream 404 from the model provider comes
// back as a 200 from OpenCode's own /message route, with the failure folded
// into `info.error` and `parts` left empty — never a non-ok HTTP response.
// Trusting that 200 as success is the same mistake Claude Code's
// `result.subtype === 'success'` almost caused; this must fail the same way.
test('an upstream failure embedded in a 200 response fails the turn, not a silent empty reply', async () => {
  const { fetchImpl } = stubFetch({
    'POST /session/ses_abc/message': {
      info: {
        id: 'msg_9',
        role: 'assistant',
        time: { created: 5 },
        error: {
          name: 'APIError',
          data: { message: 'Resource not found', statusCode: 404 },
        },
      },
      parts: [],
    },
  });
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  await assert.rejects(
    () => backend.sendMessage('ses_abc', { text: 'say exactly: ping ok' }),
    /Resource not found/,
  );
});

// ─── a turn that never answers ─────────────────────────────────────
// `POST /session/{id}/message` holds the POST open until the whole turn is done,
// so a free model that accepts a turn and then says nothing was reported after
// five minutes as `could not reach ... (Headers Timeout Error)`, with OpenCode
// still burning the turn. `prompt_async` returns at once and the turn is then
// completed from the bus, with silence bounded by what is actually meaningful:
// progress, a running tool, and a provider that is failing over.

const SILENT_MODEL = { providerId: 'opencode', modelId: 'longcat-2.5-preview-free' };
/** Bounds short enough to fail in real time; production takes the exported ones. */
const FAST_BOUNDS = { firstOutputIdleMs: 150, idleMs: 150 };

/**
 * Start a turn. Its rejection is claimed here so a turn that fails while the
 * fixture is still getting ready can never surface as an unhandled rejection;
 * a test that expects one reads it through `failureWithin`.
 */
function startTurn(backend, options = {}) {
  const turn = backend.sendMessage('ses_abc', { text: 'say hi', model: SILENT_MODEL, ...options });
  turn.catch(() => undefined);
  return turn;
}

function waitUntil(check, what = 'the bus subscription', timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/**
 * How a turn ended, or `null` when it was still running `ms` later. It never
 * rejects, so waiting on it can never leave an unhandled rejection behind when
 * the turn fails before the test gets there.
 */
function failureWithin(turn, ms = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    turn.then(
      (value) => { clearTimeout(timer); resolve({ value }); },
      (error) => { clearTimeout(timer); resolve({ error }); },
    );
  });
}

const idleFrame = { type: 'session.idle', properties: { sessionID: 'ses_abc' } };
/**
 * A finished assistant message, stamped when the route is answered so it is this
 * turn's own: a message the session held before the send is the previous turn's
 * answer and must never be served as this one's.
 */
const assistantMessage = (text) => {
  const at = Date.now();
  return {
    info: { id: 'msg_a', role: 'assistant', sessionID: 'ses_abc', time: { created: at, completed: at } },
    parts: [{ type: 'text', text }],
  };
};
/** The same, from before this turn: the answer the operator already has. */
const olderAssistantMessage = (text) => {
  const at = Date.now() - 60_000;
  return {
    info: { id: 'msg_old', role: 'assistant', sessionID: 'ses_abc', time: { created: at, completed: at } },
    parts: [{ type: 'text', text }],
  };
};
const assistantPart = (text) => partUpdated({ id: 'prt_a', type: 'text', text, messageID: 'msg_a' });
const answerDelta = (text) => ({
  type: 'message.part.delta',
  properties: { sessionID: 'ses_abc', messageID: 'msg_a', partID: 'prt_a', field: 'text', delta: text },
});

test('the production silence bounds are a minute before output and three after', () => {
  assert.equal(OPENCODE_FIRST_OUTPUT_IDLE_MS, 60_000);
  assert.equal(OPENCODE_IDLE_MS, 180_000);
});

test('a turn is submitted to prompt_async and completed from the bus', async () => {
  const { backend, calls, opened, send } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    // Stamped per request: the read-back is checked against when the send went
    // out, so a message has to be this turn's own.
    'GET /session/ses_abc/message': () => [assistantMessage('the answer')],
  });
  const turn = startTurn(backend);
  await waitUntil(opened);
  send(assistantPart(''));
  send(answerDelta('the answer'));
  send(idleFrame);
  const result = await turn;
  assert.equal(result.text, 'the answer');
  assert.equal(result.message.id, 'msg_a');
  // The bus subscription is opened before the prompt, so the submit is not the
  // first call the server sees.
  assert.deepEqual(calls.find((call) => call.path === '/session/ses_abc/prompt_async'), {
    path: '/session/ses_abc/prompt_async',
    method: 'POST',
    body: { model: { providerID: 'opencode', modelID: 'longcat-2.5-preview-free' }, parts: [{ type: 'text', text: 'say hi' }] },
  });
});

test('a turn the server reports as failed fails with the upstream message', async () => {
  const { backend, opened, send } = liveBackend({ 'POST /session/ses_abc/prompt_async': { ok: true } });
  const turn = startTurn(backend);
  await waitUntil(opened);
  send({
    type: 'session.error',
    properties: { sessionID: 'ses_abc', error: { name: 'ProviderAuthError', message: 'no credit on this account' } },
  });
  await assert.rejects(() => turn, /no credit on this account/);
});

// An idle turn whose final message carries `info.error` is the same upstream
// failure the blocking route folded into its 200 response: it must fail the same
// way, not return an empty reply.
test('an upstream failure in the completed turn fails it rather than returning nothing', async () => {
  const { backend, opened, send } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    'GET /session/ses_abc/message': () => [{
      info: {
        id: 'msg_a',
        role: 'assistant',
        sessionID: 'ses_abc',
        time: { created: Date.now(), completed: Date.now() },
        error: { name: 'APIError', data: { message: 'Resource not found' } },
      },
      parts: [],
    }],
  });
  const turn = startTurn(backend);
  await waitUntil(opened);
  send(idleFrame);
  await assert.rejects(() => turn, /Resource not found/);
});

test('a bus that stays silent fails with the model named, and stops the server turn', async () => {
  const { backend, calls, opened } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    'POST /session/ses_abc/abort': { ok: true },
  }, FAST_BOUNDS);
  const turn = startTurn(backend);
  await waitUntil(opened);
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `the silence bound must end the turn: ${JSON.stringify(outcome)}`);
  assert.match(
    outcome.error.message,
    /opencode\/longcat-2\.5-preview-free did not answer within \d+ s\. OpenCode stopped the turn - try another model\./,
  );
  // The turn the server is still running must not outlive the Gate giving up.
  assert.ok(
    calls.some((call) => call.path === '/session/ses_abc/abort'),
    `the silent turn must be stopped: ${JSON.stringify(calls)}`,
  );
});

test('a turn that keeps streaming is never cut off, however long it runs', async () => {
  const { backend, opened, send } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    'GET /session/ses_abc/message': () => [assistantMessage('a long answer')],
  }, FAST_BOUNDS);
  const turn = startTurn(backend);
  await waitUntil(opened);
  send(messageUpdated('msg_a', 'assistant'));
  send(assistantPart(''));
  // Steadier than the bound, for longer than it: every delta is a sign of life.
  for (let index = 0; index < 12; index += 1) {
    send(answerDelta('word '));
    await delay(25);
  }
  send(idleFrame);
  const result = await turn;
  assert.equal(result.text, 'a long answer');
});

test('a tool that runs longer than the bound is the turn working, not a dead turn', async () => {
  const { backend, opened, send } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    'GET /session/ses_abc/message': () => [assistantMessage('done')],
  }, FAST_BOUNDS);
  const turn = backend.sendMessage('ses_abc', { text: 'run the suite', model: SILENT_MODEL });
  await waitUntil(opened);
  send(partUpdated({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running', input: { command: 'npm test' } } }));
  // Three times the bound with nothing but the running tool on the bus.
  await delay(FAST_BOUNDS.firstOutputIdleMs * 3);
  send(partUpdated({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', output: 'ok' } }));
  send(assistantPart('done'));
  send(idleFrame);
  const result = await turn;
  assert.equal(result.text, 'done');
});

// OpenCode retrying the provider emits a status frame and no answer: it is not
// progress, so it must not re-arm the bound, and why the provider is failing
// belongs in the failure the operator reads.
test('a provider that keeps retrying is not progress, and its reason is reported', async () => {
  const { backend, calls, opened, send } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    'POST /session/ses_abc/abort': { ok: true },
  }, FAST_BOUNDS);
  const turn = startTurn(backend);
  await waitUntil(opened);
  // Claim the outcome before the retries start, so the turn's rejection always
  // has a handler even if the bound expires mid-loop.
  const failure = failureWithin(turn);
  for (let index = 0; index < 6; index += 1) {
    send({ type: 'session.status', properties: { sessionID: 'ses_abc', type: 'retry', message: '503 from provider' } });
    await delay(10);
  }
  const outcome = await failure;
  assert.ok(outcome?.error, `a retrying provider is not progress: the bound must expire. ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /did not answer within \d+ s\..*\(the provider kept failing: 503 from provider\)/);
  assert.ok(calls.some((call) => call.path === '/session/ses_abc/abort'), 'the stuck turn must be stopped');
});

test('the caller aborting a turn stops it on the server too', async () => {
  const { backend, calls, opened } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    'POST /session/ses_abc/abort': { ok: true },
  }, FAST_BOUNDS);
  const controller = new AbortController();
  const turn = startTurn(backend, { signal: controller.signal });
  await waitUntil(opened);
  controller.abort();
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `an abort must settle the turn: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /aborted/);
  assert.ok(calls.some((call) => call.path === '/session/ses_abc/abort'), 'an abort must stop the server turn');
});

// ─── a turn that is over before the send is answered ───────────────
// `prompt_async` returns as soon as the server accepts the turn, and the turn can
// be finished by then: a provider that refuses at once, a cached reply. A
// subscription opened *after* the POST has already missed the `session.idle` /
// `session.error` that ended it, so the wait saw silence for a turn that was over
// — reported as "<model> did not answer", with the answer sitting in the session.
// These fixtures broadcast when the prompt is posted, which is what a real bus
// does: a frame with no subscriber is gone.

test('a turn the bus finishes before the send is answered is that answer, not a failure', async () => {
  const { backend, calls } = liveBackend({
    'POST /session/ses_abc/prompt_async': (_init, server) => { server.broadcast(idleFrame); return { ok: true }; },
    'GET /session/ses_abc/message': () => [assistantMessage('answered already')],
    'POST /session/ses_abc/abort': { ok: true },
  }, FAST_BOUNDS);
  const started = Date.now();
  const result = await startTurn(backend);
  assert.equal(result.text, 'answered already');
  assert.equal(result.message.id, 'msg_a');
  // The bound was a fraction of a second away: this can only be the answer.
  assert.ok(Date.now() - started < FAST_BOUNDS.firstOutputIdleMs, 'the turn must not have waited out the bound');
  assert.ok(
    !calls.some((call) => call.path === '/session/ses_abc/abort'),
    `a turn that answered must not be stopped: ${JSON.stringify(calls)}`,
  );
});

test('an upstream failure reported before the send is answered fails with its message', async () => {
  const { backend, calls } = liveBackend({
    'POST /session/ses_abc/prompt_async': (_init, server) => {
      server.broadcast({
        type: 'session.error',
        properties: { sessionID: 'ses_abc', error: { name: 'ProviderAuthError', message: 'no credit on this account' } },
      });
      return { ok: true };
    },
    'POST /session/ses_abc/abort': { ok: true },
  }, FAST_BOUNDS);
  const outcome = await failureWithin(startTurn(backend));
  assert.ok(outcome?.error, `the turn must fail: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /no credit on this account/);
  assert.doesNotMatch(outcome.error.message, /did not answer/, 'a reported failure is not silence');
  assert.ok(!calls.some((call) => call.path === '/session/ses_abc/abort'), 'a failed turn is already over');
});

// The bus is a witness, not the record: a turn can finish while the subscription
// is still opening, or after it died, and the session's messages are what prove
// it. The silence bound must ask them before it stops a turn that answered.
test('a silent bus that already holds this turn\'s finished message answers it', async () => {
  const { backend, calls } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    'GET /session/ses_abc/message': () => [assistantMessage('finished while the bus was quiet')],
    'POST /session/ses_abc/abort': { ok: true },
  }, FAST_BOUNDS);
  const result = await startTurn(backend);
  assert.equal(result.text, 'finished while the bus was quiet');
  assert.ok(
    !calls.some((call) => call.path === '/session/ses_abc/abort'),
    `a turn that answered must not be stopped: ${JSON.stringify(calls)}`,
  );
});

// The session's last assistant message is the *previous* turn's answer whenever
// this turn produced none — an upstream failure that created no message of its
// own. Serving it again would answer the operator with what they already have,
// so an empty turn must read as empty.
test('an idle turn with no message of its own does not answer with the last one', async () => {
  const { backend, opened, send } = liveBackend({
    'POST /session/ses_abc/prompt_async': { ok: true },
    'GET /session/ses_abc/message': [olderAssistantMessage('the answer to the last question')],
  }, FAST_BOUNDS);
  const turn = startTurn(backend);
  await waitUntil(opened);
  send(idleFrame);
  const result = await turn;
  assert.equal(result.text, '', "the previous turn's answer must not be served as this one's");
  assert.equal(result.message, null);
});

test('a server without the async prompt falls back to the blocking send', async () => {
  const { calls, fetchImpl } = stubFetch({
    'POST /session/ses_abc/message': assistantMessage('contract ok'),
  });
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const result = await backend.sendMessage('ses_abc', { text: 'say hi', model: SILENT_MODEL });
  assert.equal(result.text, 'contract ok');
  // 404 on the async route, then the send this Gate has always made. The bus
  // subscription is opened first, and this server has no bus at all.
  const sent = calls.filter((call) => call.path !== '/event');
  assert.deepEqual(sent.map((call) => call.path), ['/session/ses_abc/prompt_async', '/session/ses_abc/message']);
  assert.deepEqual(sent[1].body, {
    model: { providerID: 'opencode', modelID: 'longcat-2.5-preview-free' },
    parts: [{ type: 'text', text: 'say hi' }],
  });
});

test('abort cancels the active turn', async () => {
  const { calls, fetchImpl } = stubFetch({ 'POST /session/ses_abc/abort': { ok: true } });
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  await backend.abort('ses_abc');
  assert.equal(calls[0].path, '/session/ses_abc/abort');
});

test('an approval reply reaches the session permission route', async () => {
  const { calls, fetchImpl } = stubFetch({ 'POST /session/ses_abc/permission/perm_1/reply': { ok: true } });
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  await backend.replyApproval('ses_abc', 'perm_1', 'approve');
  assert.equal(calls[0].path, '/session/ses_abc/permission/perm_1/reply');
  assert.equal(calls[0].body.reply, 'approve');
});

// ─── guarded-server credentials ──────────────────────────────────────
// backendManager.get passes { baseUrl, credentials, record } to the adapter,
// but createOpenCodeBackend reads only `password` — so a guarded `opencode
// serve` attaches healthy (the health check sends OPENCODE_SERVER_PASSWORD)
// then 401s on every session/message call. The adapter maps the credential.

function headerCaptureFetch() {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(init.headers ?? {});
    return { ok: true, status: 200, async json() { return []; }, async text() { return '[]'; } };
  };
  return { seen, fetchImpl };
}

test('a guarded server created through the adapter sends the bearer header', async () => {
  const { seen, fetchImpl } = headerCaptureFetch();
  const backend = opencodeAdapter.createBackend({
    baseUrl: 'http://127.0.0.1:4096',
    credentials: { OPENCODE_SERVER_PASSWORD: 's3cret' },
    record: {},
    fetchImpl,
  });
  await backend.listSessions();
  assert.equal(seen[0].Authorization, 'Bearer s3cret');
});

test('a server with no password sends no auth header', async () => {
  const { seen, fetchImpl } = headerCaptureFetch();
  const backend = opencodeAdapter.createBackend({
    baseUrl: 'http://127.0.0.1:4096',
    credentials: {},
    record: {},
    fetchImpl,
  });
  await backend.listSessions();
  assert.equal(seen[0].Authorization, undefined);
});

test('an explicit password still wins over the credential binding', async () => {
  const { seen, fetchImpl } = headerCaptureFetch();
  const backend = opencodeAdapter.createBackend({
    baseUrl: 'http://127.0.0.1:4096',
    credentials: { OPENCODE_SERVER_PASSWORD: 'bound' },
    password: 'explicit',
    fetchImpl,
  });
  await backend.listSessions();
  assert.equal(seen[0].Authorization, 'Bearer explicit');
});

// ─── a server that is running but not answering ───────────────────────
// `opencode serve` accepts the TCP connection and then stops answering — its
// first start after a reboot alone takes well over 30 s (native-server.mjs). No
// OpenCode read carried a signal of its own, so every one of them waited out
// undici's own ~300 s headers timeout and the operator read
// `could not reach … (Headers Timeout Error)` instead of a reason. The Hermes
// backend in the same directory bounds exactly these reads (readCall, 30 s).

/**
 * A server that accepts the connection and never answers.
 *
 * Models a real fetch: it settles when its own signal aborts, and holds a ref'd
 * handle until then, because `AbortSignal.timeout()` arms an unref'd timer and a
 * fetch that never arrives would otherwise leave the loop with nothing to wait
 * on.
 */
function silentFetch() {
  return (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      const inFlight = setTimeout(() => {}, 5_000);
      const fail = () => {
        clearTimeout(inFlight);
        reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
      };
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener('abort', fail, { once: true });
    });
}

/** The read's verdict, or `pending` — so an unbounded read settles the suite red. */
function readOutcome(read) {
  return Promise.race([
    read().then(() => ({ state: 'resolved' }), (error) => ({ state: 'rejected', error })),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ state: 'pending' }), 3_000);
      timer.unref?.();
    }),
  ]);
}

test('a server that is running but not answering is named on every read', async () => {
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: silentFetch(),
    readTimeoutMs: 40,
  });

  for (const [what, read] of [
    ['the session list', () => backend.listSessions()],
    ['a message read', () => backend.listMessages('ses_abc')],
    ['the model list', () => backend.listModels()],
    ['a session delete', () => backend.deleteSession('ses_abc')],
    ['stopping a turn', () => backend.abort('ses_abc')],
  ]) {
    const outcome = await readOutcome(read);
    assert.equal(outcome.state, 'rejected', `${what} must be bounded, not waited out`);
    assert.equal(outcome.error.code, 'backend_timeout', `${what} fails with the read ceiling's own code`);
    assert.match(outcome.error.message, /sent no response within/i);
    // Deliberately not "did not answer within Ns": that is the verdict about a
    // MODEL that accepted a turn and went quiet, and a transport that stopped
    // answering must not be held against the model (core/model-fault.mjs).
    assert.doesNotMatch(outcome.error.message, /did not answer within/i);
  }
});

test('the blocking route is a turn, not a read: it keeps the turn bound', async () => {
  // A server that predates `prompt_async` answers the blocking POST only once
  // the whole turn is done, so the read ceiling — 40 ms here — must not cut a
  // real turn short. The turn's own silence bound is what applies to it.
  const late = { ok: true, status: 200, async text() { return JSON.stringify(assistantMessage('slow but complete')); } };
  const gone = { ok: false, status: 404, async text() { return 'not found'; } };
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/session/ses_abc/message' && init.method === 'POST') {
      await new Promise((resolve) => { setTimeout(resolve, 90); });
      return late;
    }
    return gone;
  };
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl,
    readTimeoutMs: 40,
    firstOutputIdleMs: 5_000,
    idleMs: 5_000,
  });

  const result = await backend.sendMessage('ses_abc', { text: 'say hi', model: SILENT_MODEL });

  assert.equal(result.text, 'slow but complete', 'a slow turn on an old server is still answered');
});
