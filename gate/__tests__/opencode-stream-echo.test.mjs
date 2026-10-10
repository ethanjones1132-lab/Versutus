import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';
import { runBackendTurn } from '../core/voice/turn-runner.mjs';

// Issue #1 item 4: OpenCode publishes the user's own message on the same event
// bus as the reply, so a streamed reply began with the prompt. Once the answer
// went missing altogether although OpenCode stored it.

const PROMPT = 'What is 2+2? Answer in one sentence.';
const ANSWER = '2+2 is 4.';
const SID = 'ses_abc';

// The order opencode 1.18 publishes a turn in: the user message envelope, its
// text part, then the assistant envelope, an empty text part, deltas, the
// closing snapshot, idle. Session ids sit where the real bus puts them.
const RECORDED_TURN = [
  { type: 'message.updated', properties: { info: { id: 'msg_u1', sessionID: SID, role: 'user', time: { created: 1 } } } },
  { type: 'message.part.updated', properties: { part: { id: 'prt_u1', sessionID: SID, messageID: 'msg_u1', type: 'text', text: PROMPT } } },
  { type: 'message.updated', properties: { info: { id: 'msg_a1', sessionID: SID, role: 'assistant', parentID: 'msg_u1', time: { created: 2 } } } },
  { type: 'message.part.updated', properties: { part: { id: 'prt_a1', sessionID: SID, messageID: 'msg_a1', type: 'text', text: '' } } },
  { type: 'message.part.delta', properties: { sessionID: SID, messageID: 'msg_a1', partID: 'prt_a1', field: 'text', delta: '2+2 ' } },
  { type: 'message.part.delta', properties: { sessionID: SID, messageID: 'msg_a1', partID: 'prt_a1', field: 'text', delta: 'is 4.' } },
  { type: 'message.part.updated', properties: { part: { id: 'prt_a1', sessionID: SID, messageID: 'msg_a1', type: 'text', text: ANSWER } } },
  { type: 'session.idle', properties: { sessionID: SID } },
];

const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

function streamOf(events, { routes = {} } = {}) {
  const encoder = new TextEncoder();
  return createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async (url) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      if (path === '/event') {
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sse(events)));
              controller.close();
            },
          }),
        };
      }
      if (routes[path]) {
        const body = JSON.stringify(routes[path]);
        return {
          ok: true,
          status: 200,
          async json() { return routes[path]; },
          async text() { return body; },
        };
      }
      return { ok: false, status: 404, async text() { return 'not found'; } };
    },
  });
}

async function collect(backend) {
  const seen = [];
  await backend.streamEvents(SID, (event) => seen.push(event));
  return seen;
}

const answerText = (events) => events.filter((event) => event.type === 'message.delta').map((event) => event.payload.text).join('');

test('a recorded turn streams only the answer, never the echoed prompt', async () => {
  const seen = await collect(streamOf(RECORDED_TURN));
  assert.equal(answerText(seen), ANSWER);
  assert.ok(!JSON.stringify(seen).includes(PROMPT), 'the prompt must not reach the client in any frame');
  assert.equal(seen.at(-1).type, 'run.completed');
});

test('a user message streamed as deltas is dropped as well', async () => {
  const seen = await collect(streamOf([
    RECORDED_TURN[0],
    { type: 'message.part.updated', properties: { part: { id: 'prt_u1', sessionID: SID, messageID: 'msg_u1', type: 'text', text: '' } } },
    { type: 'message.part.delta', properties: { sessionID: SID, messageID: 'msg_u1', partID: 'prt_u1', field: 'text', delta: PROMPT } },
    ...RECORDED_TURN.slice(2),
  ]));
  assert.equal(answerText(seen), ANSWER);
});

test('a held part whose lookup says role:user is dropped, and the turn still completes', async () => {
  const seen = await collect(streamOf([
    // No envelope for msg_u2 on the bus: the part's type and owner are unknown.
    { type: 'message.part.delta', properties: { sessionID: SID, messageID: 'msg_u2', partID: 'prt_u2', field: 'text', delta: PROMPT } },
    ...RECORDED_TURN.slice(2),
  ], {
    routes: {
      [`/session/${SID}/message/msg_u2`]: {
        info: { id: 'msg_u2', sessionID: SID, role: 'user' },
        parts: [{ id: 'prt_u2', sessionID: SID, messageID: 'msg_u2', type: 'text', text: PROMPT }],
      },
    },
  }));
  assert.equal(answerText(seen), ANSWER);
  assert.equal(seen.at(-1).type, 'run.completed', 'a dropped prompt is not an unclassified omission');
  assert.ok(!seen.some((event) => event.type === 'diagnostic' && event.payload?.reason === 'unclassifiable-part-metadata'));
});

test('assistant parts of the same session are untouched when no role is known (legacy shapes)', async () => {
  const seen = await collect(streamOf(RECORDED_TURN.filter((event) => event.type !== 'message.updated')));
  // Without envelopes there is nothing to filter on; behaviour is as before.
  assert.equal(answerText(seen), PROMPT + ANSWER);
});

// ─── through the turn runner: the missing-answer timing case ─────────────────

/**
 * An OpenCode server whose POST /message answers while the bus has delivered
 * only the echoed prompt and the first fragment of the reply -- the race the
 * issue observed. The bus never sends the rest (nor idle) before the runner
 * stops listening.
 */
function racingServer({ busEvents, finalParts }) {
  const encoder = new TextEncoder();
  // OpenCode's `/event` bus is global: every subscriber sees the same frames.
  // The turn runner listens on one, and sendMessage opens another to know when
  // the turn goes idle, so a single last-writer controller would hand the tool
  // call to the subscription that is about to close and the runner would never
  // see it.
  const buses = new Set();
  const sent = [];
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl: async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      if (path === '/event') {
        let controller;
        return {
          ok: true,
          body: new ReadableStream({
            start(streamController) {
              controller = streamController;
              buses.add(streamController);
            },
            cancel() { buses.delete(controller); },
          }),
        };
      }
      if (path === `/session/${SID}/message` && init.method === 'POST') {
        sent.push(JSON.parse(init.body));
        const frame = encoder.encode(sse(busEvents));
        for (const controller of buses) {
          try { controller.enqueue(frame); } catch { /* a subscriber that already closed */ }
        }
        // Let the bus frames be read, then answer before anything else arrives.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const body = JSON.stringify({ info: { id: 'msg_a1', role: 'assistant', sessionID: SID }, parts: finalParts });
        return {
          ok: true,
          status: 200,
          async json() { return JSON.parse(body); },
          async text() { return body; },
        };
      }
      return { ok: false, status: 404, async text() { return 'not found'; } };
    },
  });
  return { backend, sent };
}

function collector() {
  const deltas = [];
  const tools = [];
  return {
    deltas,
    tools,
    handlers: {
      onDelta: (text) => deltas.push(text),
      onToolCall: (call) => tools.push(call),
      onApproval: () => {},
      onChunk: () => {},
    },
  };
}

test('a send that answers before the bus finishes still delivers the whole answer, once, without the prompt', async () => {
  const { backend, sent } = racingServer({
    busEvents: RECORDED_TURN.slice(0, 5), // user echo + assistant envelope + first delta ('2+2 ')
    finalParts: [{ type: 'text', text: ANSWER }],
  });
  const seen = collector();
  const outcome = await runBackendTurn(backend, SID, { text: PROMPT }, seen.handlers);
  assert.equal(sent.length, 1);
  assert.equal(outcome.hasContent, true);
  assert.equal(seen.deltas.join(''), ANSWER, 'streamed head + back-filled tail, nothing doubled');
  assert.ok(!seen.deltas.join('').includes(PROMPT));
});

test('a turn whose feed carried only a tool call still delivers the stored answer', async () => {
  const { backend } = racingServer({
    busEvents: [
      RECORDED_TURN[0],
      RECORDED_TURN[1],
      RECORDED_TURN[2],
      { type: 'message.part.updated', properties: { part: { id: 'prt_t1', sessionID: SID, messageID: 'msg_a1', type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'running', input: { path: 'a.txt' } } } } },
    ],
    finalParts: [{ type: 'text', text: ANSWER }],
  });
  const seen = collector();
  const outcome = await runBackendTurn(backend, SID, { text: PROMPT }, seen.handlers);
  assert.equal(outcome.hasContent, true);
  assert.equal(seen.tools.length > 0, true);
  assert.equal(seen.deltas.join(''), ANSWER);
});

test('a feed that delivered the whole answer is not echoed a second time', async () => {
  const { backend } = racingServer({
    busEvents: RECORDED_TURN.slice(0, 7),
    finalParts: [{ type: 'text', text: ANSWER }],
  });
  const seen = collector();
  await runBackendTurn(backend, SID, { text: PROMPT }, seen.handlers);
  assert.equal(seen.deltas.join(''), ANSWER);
});
