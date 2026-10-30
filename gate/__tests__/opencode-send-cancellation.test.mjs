import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';

// VS-004 — a cancelled send must never submit its prompt.
//
// `sendMessage` subscribed first and awaited the bus's ready point, but it never
// looked at the caller's signal again: a Stop pressed before the send, or while
// the subscription was still opening, still POSTed `prompt_async`, wrote the
// cancelled message into the session and started a model turn — then ran a
// best-effort stop. The v1 404 fallback was worse: the blocking POST /message
// went out without the signal at all, so Stop could not cancel it and the Gate
// waited out the turn's silence bound while OpenCode kept working.
//
// The fixtures below are hermetic: a fetch fake, a fake event bus, and deferred
// promises for the routes that must stay open. A route held open rejects only
// when its request signal aborts, exactly as a real fetch does, so a broken send
// is seen failing rather than silently waiting.

const SESSION_ID = 'ses_cancel';
const MODEL = { providerId: 'opencode', modelId: 'cancel-free' };
/** Real-time bounds short enough to fail fast; production takes its own. */
const BOUNDS = { firstOutputIdleMs: 2_000, idleMs: 2_000 };
/** How long a cancelled send may take to settle before it is a hang. */
const SETTLE_MS = 1_000;

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError() {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

/**
 * A signal the send is handed instead of the bare one, so a test can see which
 * abort listeners the turn still holds — a `once` listener on an aborted signal
 * disappears on its own, so the raw target cannot tell "retired" from "fired".
 */
function trackedSignal(raw) {
  const live = new Set();
  const signal = {
    get aborted() { return raw.aborted; },
    addEventListener(type, listener, options) {
      if (type === 'abort') live.add(listener);
      raw.addEventListener(type, listener, options);
    },
    removeEventListener(type, listener, options) {
      if (type === 'abort') live.delete(listener);
      raw.removeEventListener(type, listener, options);
    },
  };
  return { raw, signal, live };
}

function assertRetired(tracked, message) {
  assert.equal(tracked.live.size, 0, message);
  assert.deepEqual(getEventListeners(tracked.raw, 'abort'), [], message);
}

/** A request a real fetch holds open until its own request signal aborts. */
function heldUntilAbort(signal) {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(abortError());
    if (signal?.aborted) { fail(); return; }
    signal?.addEventListener('abort', fail, { once: true });
  });
}

/** A wedged socket: the request never answers at all, even when cancelled. */
function neverAnswers() {
  return new Promise(() => {});
}

function reply(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(value); },
    async json() { return value; },
  };
}

function emptyReply(status = 204) {
  return { ok: true, status, async text() { return ''; } };
}

function refusal(status, value) {
  return { ok: false, status, async text() { return JSON.stringify(value); } };
}

/**
 * A prompt route that was accepted with nothing to show for it, like the real
 * 204. `accepted` is settled the moment the backend has read the response, so a
 * test can abort strictly after acceptance instead of guessing with a delay.
 */
function acceptedReply(accepted) {
  return {
    ok: true,
    status: 200,
    async text() { accepted.resolve(); return ''; },
  };
}

/** The fake shared bus: one open body, frames only to whoever is attached now. */
function eventStream() {
  const encoder = new TextEncoder();
  let controller = null;
  return {
    response: {
      ok: true,
      status: 200,
      body: new ReadableStream({ start(start) { controller = start; } }),
    },
    send(event) {
      if (!controller) return;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        // Published to nobody, exactly as a frame on a real bus is.
      }
    },
  };
}

function v1Session() {
  const at = Date.now();
  return {
    id: SESSION_ID,
    title: 'Cancel thread',
    parentID: null,
    time: { created: at, updated: at },
    tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
  };
}

/** A finished v1 assistant message, stamped when the route answers. */
function v1Assistant(text = 'the answer') {
  const at = Date.now();
  return {
    info: { id: 'msg_a', role: 'assistant', sessionID: SESSION_ID, time: { created: at, completed: at } },
    parts: [{ type: 'text', text }],
  };
}

/** A finished v2 assistant message: the role is `type` there. */
function v2Assistant(text = 'the answer') {
  const at = Date.now();
  return {
    id: 'msg_a',
    type: 'assistant',
    time: { created: at, completed: at },
    content: [{ type: 'text', text }],
  };
}

/**
 * A fake OpenCode server on a fetch fake.
 *
 * `major` picks the dialect (the classification probes answer accordingly).
 * `prompt` is `accept` (accepted, no body), `missing` (404, the v1 fallback),
 * `refused` (500), `stuck` (held until its request signal aborts) or `gated`
 * (ignores the signal and answers 404 once the test opens `gate`).
 * `blocking` is the v1 POST /message: `answer` or `stuck` (held until its own
 * request signal aborts).
 * `bus` is `open` or `stuck` (the subscription GET never answers).
 * `idleOnAccept` broadcasts the v1 terminal frame when the prompt is accepted.
 * `idleWitness` answers the v2 wait route with its idle 204; false holds it
 * open so only the cancellation can settle it.
 */
function startServer({
  major = 1,
  prompt = 'accept',
  blocking = 'answer',
  bus = 'open',
  idleOnAccept = false,
  idleWitness = true,
  gate = null,
} = {}) {
  const shared = eventStream();
  const state = {
    requests: [],
    posted: deferred(),
    accepted: deferred(),
    blockingPosted: deferred(),
    promptSignal: null,
    messageSignal: null,
  };

  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init.method ?? 'GET';
    state.requests.push({
      method,
      path,
      body: init.body ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? null,
    });
    // A real fetch refuses an already-aborted request before it reaches the
    // server; recording it first is how a broken send is seen attempting one.
    if (init.signal?.aborted) throw abortError();

    if (path === '/session' && method === 'GET') {
      // v2's SPA catch-all answers /session with HTML, which fails JSON parsing
      // and lets the v2 probe identify the server.
      return major >= 2
        ? { ok: true, status: 200, async text() { return '<html>spa</html>'; } }
        : reply([v1Session()]);
    }
    if (path === '/api/info' && method === 'GET') return reply({ version: '2.0.32' });
    if (path === '/event' || path === '/api/event') {
      return bus === 'stuck' ? neverAnswers() : shared.response;
    }

    if (path === `/session/${SESSION_ID}/prompt_async` && method === 'POST') {
      state.promptSignal = init.signal ?? null;
      state.posted.resolve();
      if (prompt === 'missing') return refusal(404, { name: 'NotFound', data: { message: 'no such route' } });
      if (prompt === 'refused') return refusal(500, { name: 'UnknownError', data: { message: 'boom' } });
      if (prompt === 'gated') { await gate; return refusal(404, { name: 'NotFound', data: { message: 'no such route' } }); }
      if (prompt === 'stuck') return heldUntilAbort(init.signal);
      if (idleOnAccept) shared.send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
      return acceptedReply(state.accepted);
    }
    if (path === `/session/${SESSION_ID}/message` && method === 'POST') {
      state.messageSignal = init.signal ?? null;
      state.blockingPosted.resolve();
      if (blocking === 'stuck') return heldUntilAbort(init.signal);
      return reply(v1Assistant());
    }
    if (path === `/session/${SESSION_ID}/message` && method === 'GET') {
      return reply([v1Assistant()]);
    }
    if (path === `/session/${SESSION_ID}/abort` && method === 'POST') return reply({ ok: true });

    if (path === `/api/session/${SESSION_ID}/model` && method === 'POST') return emptyReply(204);
    if (path === `/api/session/${SESSION_ID}/prompt` && method === 'POST') {
      state.promptSignal = init.signal ?? null;
      state.posted.resolve();
      if (prompt === 'refused') return refusal(500, { name: 'UnknownError', data: { message: 'boom' } });
      if (prompt === 'stuck') return heldUntilAbort(init.signal);
      return acceptedReply(state.accepted);
    }
    if (path === `/api/experimental/session/${SESSION_ID}/wait` && method === 'POST') {
      // The completion witness: idle on the success path, held open otherwise
      // so a cancelled turn is the only thing that can settle it.
      return idleWitness ? emptyReply(204) : heldUntilAbort(init.signal);
    }
    if (path === `/api/session/${SESSION_ID}/interrupt` && method === 'POST') return reply({ ok: true });
    if (path === `/api/session/${SESSION_ID}/message` && method === 'GET') {
      return reply({ data: [v2Assistant(), { type: 'idle', outcome: 'succeeded' }], cursor: { next: null } });
    }
    return refusal(404, { name: 'NotFound', data: { message: 'no such route' } });
  };

  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl,
    ...BOUNDS,
  });
  return { backend, state };
}

/** Every POST this turn made under a session: exact count and exact session id. */
function sessionPosts(state, prefix) {
  return state.requests
    .filter((request) => request.method === 'POST' && request.path.startsWith(prefix))
    .map((request) => request.path);
}

const V1 = `/session/${SESSION_ID}`;
const V2 = `/api/session/${SESSION_ID}`;

function waitUntil(check, what = 'the route request', timeoutMs = 2_000) {
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

/** How the send ended, or `null` when it had not ended `ms` later. */
function failureWithin(turn, ms = SETTLE_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    turn.then(
      (value) => { clearTimeout(timer); resolve({ value }); },
      (error) => { clearTimeout(timer); resolve({ error }); },
    );
  });
}

function startSend(backend, options = {}) {
  const turn = backend.sendMessage(SESSION_ID, { text: 'say hi', model: MODEL, ...options });
  turn.catch(() => undefined);
  return turn;
}

// ─── cancelled before anything is submitted ─────────────────────────

test('a v1 send whose signal is already aborted posts no prompt at all', async () => {
  const { backend, state } = startServer();
  const controller = new AbortController();
  controller.abort();
  const tracked = trackedSignal(controller.signal);

  const started = Date.now();
  await assert.rejects(
    () => backend.sendMessage(SESSION_ID, { text: 'say hi', model: MODEL, signal: tracked.signal }),
    /opencode: the turn was aborted/,
  );

  assert.deepEqual(sessionPosts(state, V1), [], 'a cancelled message must never be written into the session');
  assert.ok(Date.now() - started < SETTLE_MS, 'a pre-cancelled send must fail at once, not wait out a bound');
  assertRetired(tracked, 'the cancelled turn must retire its abort listener');
  assert.ok(
    !state.requests.some((request) => request.path === '/event'),
    'a pre-cancelled send needs no bus subscription to skip the prompt',
  );
});

test('a v2 send whose signal is already aborted posts no prompt at all', async () => {
  const { backend, state } = startServer({ major: 2 });
  const controller = new AbortController();
  controller.abort();
  const tracked = trackedSignal(controller.signal);

  await assert.rejects(
    () => backend.sendMessage(SESSION_ID, { text: 'say hi', model: MODEL, signal: tracked.signal }),
    /opencode: the turn was aborted/,
  );

  assert.deepEqual(
    sessionPosts(state, V2),
    [],
    'a cancelled v2 prompt must never be posted, not even the model switch',
  );
  assertRetired(tracked, 'the cancelled v2 turn must retire its abort listener');
});

test('an abort while the v1 subscription is still opening posts no prompt', async () => {
  // The bus GET never answers: the ready point is pending, which is exactly the
  // up-to-3 s window a Stop used to be ignored in.
  const { backend, state } = startServer({ bus: 'stuck' });
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);
  const turn = startSend(backend, { signal: tracked.signal });
  await waitUntil(() => state.requests.some((request) => request.path === '/event'), 'the subscription request');

  const started = Date.now();
  controller.abort();
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `an abort during the ready wait must settle the caller: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /opencode: the turn was aborted/);
  assert.ok(Date.now() - started < SETTLE_MS, 'the ready wait must answer to the signal, not only its own ceiling');

  assert.deepEqual(sessionPosts(state, V1), [], 'no prompt may be posted for a cancelled turn');
  assertRetired(tracked, 'the turn must retire its abort listener when cancelled');
});

// ─── cancelled while a prompt acceptance is pending ─────────────────

test('an abort while the v1 prompt acceptance is pending cancels the POST and stops that session', async () => {
  const { backend, state } = startServer({ prompt: 'stuck' });
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);
  const turn = startSend(backend, { signal: tracked.signal });
  await state.posted.promise;

  const started = Date.now();
  controller.abort();
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `the caller must not wait on a cancelled POST: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /opencode: the turn was aborted/);
  assert.ok(Date.now() - started < SETTLE_MS, 'a cancelled acceptance must settle promptly');

  assert.deepEqual(
    sessionPosts(state, V1),
    [`${V1}/prompt_async`, `${V1}/abort`],
    'exactly one prompt POST, then one stop for the same session',
  );
  assert.equal(state.promptSignal?.aborted, true, 'the pending prompt POST itself must be cancelled');
  assert.equal(state.messageSignal, null, 'a cancelled acceptance must never fall back to the blocking send');
  assertRetired(tracked, 'the turn must retire its abort listener when cancelled');
});

test('an abort while the v2 prompt acceptance is pending interrupts only that session', async () => {
  const { backend, state } = startServer({ major: 2, prompt: 'stuck' });
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);
  const turn = startSend(backend, { signal: tracked.signal });
  await state.posted.promise;

  controller.abort();
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `the v2 caller must not wait on a cancelled POST: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /opencode: the turn was aborted/);

  assert.deepEqual(
    sessionPosts(state, V2),
    [`${V2}/model`, `${V2}/prompt`, `${V2}/interrupt`],
    'the model switch, exactly one v2 prompt POST, then one interrupt for the same session',
  );
  assert.equal(state.promptSignal?.aborted, true, 'the pending v2 prompt POST must be cancelled');
  assertRetired(tracked, 'the v2 turn must retire its abort listener when cancelled');
});

// ─── cancelled after the prompt was accepted ────────────────────────

test('an abort after acceptance stops only the requested session and never resubmits (v1)', async () => {
  const { backend, state } = startServer();
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);
  const turn = startSend(backend, { signal: tracked.signal });
  await state.accepted.promise;

  const started = Date.now();
  controller.abort();
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `an abort after acceptance must settle the caller: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /opencode: the turn was aborted/);
  assert.ok(Date.now() - started < SETTLE_MS, 'the stop that follows an abort must stay bounded');

  assert.deepEqual(
    sessionPosts(state, V1),
    [`${V1}/prompt_async`, `${V1}/abort`],
    'one accepted prompt, one stop for that session, and nothing else',
  );
  assert.equal(state.messageSignal, null, 'cancellation must never cause a second prompt submission');
  assertRetired(tracked, 'a settled turn must retire its abort listener');

  // Nothing may arrive later from a leftover timer or subscription.
  const settled = sessionPosts(state, V1).length;
  await delay(100);
  assert.equal(sessionPosts(state, V1).length, settled, 'a settled turn must not post anything further');
});

test('an abort after acceptance interrupts only the requested session and never resubmits (v2)', async () => {
  const { backend, state } = startServer({ major: 2, idleWitness: false });
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);
  const turn = startSend(backend, { signal: tracked.signal });
  await state.accepted.promise;

  controller.abort();
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `an abort after v2 acceptance must settle the caller: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /opencode: the turn was aborted/);

  assert.deepEqual(
    sessionPosts(state, V2),
    [`${V2}/model`, `${V2}/prompt`, `${V2}/interrupt`],
    'one v2 prompt and one interrupt, both for the requested session',
  );
  assertRetired(tracked, 'the settled v2 turn must retire its abort listener');
});

// ─── the v1 404-only blocking fallback ──────────────────────────────

test('an abort during the 404 fallback cancels the blocking send and stops the same session', async () => {
  const { backend, state } = startServer({ prompt: 'missing', blocking: 'stuck' });
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);
  const turn = startSend(backend, { signal: tracked.signal });
  await state.blockingPosted.promise;

  const started = Date.now();
  controller.abort();
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `Stop must not leave the blocking send running: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /opencode: the turn was aborted/);
  assert.ok(Date.now() - started < SETTLE_MS, 'the cancelled blocking send must settle promptly');

  assert.deepEqual(
    sessionPosts(state, V1),
    [`${V1}/prompt_async`, `${V1}/message`, `${V1}/abort`],
    'one 404 probe, one blocking send, one stop — never a second submission',
  );
  assert.equal(state.messageSignal?.aborted, true, 'the blocking POST must carry the caller cancellation');
  assertRetired(tracked, 'the fallback turn must retire its abort listener');
});

test('a 404 that answers after the cancel never starts the blocking send', async () => {
  // The server ignores the cancellation and only then says it has no
  // prompt_async. A cancellation must not be turned into a second submission.
  const gate = deferred();
  const { backend, state } = startServer({ prompt: 'gated', gate: gate.promise });
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);
  const turn = startSend(backend, { signal: tracked.signal });
  await state.posted.promise;

  controller.abort();
  gate.resolve();
  const outcome = await failureWithin(turn);
  assert.ok(outcome?.error, `the cancelled send must fail: ${JSON.stringify(outcome)}`);
  assert.match(outcome.error.message, /opencode: the turn was aborted/);

  assert.deepEqual(
    sessionPosts(state, V1),
    [`${V1}/prompt_async`, `${V1}/abort`],
    'a 404 that arrives after the cancel must not start the blocking send',
  );
  assert.equal(state.messageSignal, null, 'the blocking send must never be posted for a cancelled turn');
});

// ─── the paths that must keep working ───────────────────────────────

test('a non-404 refusal is reported and never resent', async () => {
  for (const major of [1, 2]) {
    const { backend, state } = startServer({ major, prompt: 'refused' });
    const controller = new AbortController();
    const tracked = trackedSignal(controller.signal);
    const turn = startSend(backend, { signal: tracked.signal });

    await assert.rejects(() => turn, (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.message, 'opencode: boom');
      return true;
    });
    assert.deepEqual(
      sessionPosts(state, major >= 2 ? V2 : V1),
      major >= 2 ? [`${V2}/model`, `${V2}/prompt`] : [`${V1}/prompt_async`],
      'a refusal that may have been accepted must never be resent',
    );
    assert.equal(state.messageSignal, null, 'a non-404 refusal must never fall back');
    assertRetired(tracked, 'a refused turn must retire its abort listener');
  }
});

test('a successful v1 send still posts once and completes from the bus', async () => {
  const { backend, state } = startServer({ idleOnAccept: true });
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);

  const result = await backend.sendMessage(SESSION_ID, {
    text: 'say hi',
    model: MODEL,
    signal: tracked.signal,
  });

  assert.equal(result.text, 'the answer');
  assert.deepEqual(sessionPosts(state, V1), [`${V1}/prompt_async`], 'a healthy turn posts its prompt exactly once');
  assert.equal(state.promptSignal?.aborted, false, 'the accepted prompt must not be cancelled');
  assertRetired(tracked, 'a healthy turn must retire its abort listener');
});

test('a successful v2 send still posts once and completes from the wait route', async () => {
  const { backend, state } = startServer({ major: 2 });
  const controller = new AbortController();
  const tracked = trackedSignal(controller.signal);

  const result = await backend.sendMessage(SESSION_ID, {
    text: 'say hi',
    model: MODEL,
    signal: tracked.signal,
  });

  assert.equal(result.text, 'the answer');
  assert.deepEqual(
    sessionPosts(state, V2),
    [`${V2}/model`, `${V2}/prompt`],
    'the v2 dialect is preserved: model switch then prompt, once each',
  );
  const waits = state.requests.filter(
    (request) => request.path === `/api/experimental/session/${SESSION_ID}/wait`,
  );
  assert.equal(waits.length, 1, 'the v2 completion witness must still be used');
  assertRetired(tracked, 'a healthy v2 turn must retire its abort listener');
});
