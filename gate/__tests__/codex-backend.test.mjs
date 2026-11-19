import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepEventLoopAlive } from './fixtures/keep-event-loop-alive.mjs';

import {
  createCodexBackend,
  normalizeCodexEvent,
  toGatewaySession,
  toGatewayMessage,
  isApprovalRequest,
} from '../core/cli-environments/backends/codex.mjs';

function stubRpc(responses = {}) {
  const calls = [];
  return {
    calls,
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        const value = responses[method];
        if (typeof value === 'function') return value(params);
        if (value instanceof Error) throw value;
        return value ?? {};
      },
      notify() {},
    },
  };
}

/** Let a turn's promises settle between ticks of a mock clock. */
function flushTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('a thread maps onto the session shape the app parses', () => {
  const mapped = toGatewaySession({
    id: 'th_1',
    name: 'Refactor',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T01:00:00.000Z',
    tokenUsage: { input: 10, output: 20, cachedInput: 5 },
  });
  assert.equal(mapped.id, 'th_1');
  assert.equal(mapped.source, 'codex');
  assert.equal(mapped.title, 'Refactor');
  assert.equal(mapped.input_tokens, 10);
  assert.equal(mapped.cache_read_tokens, 5);
  assert.ok(mapped.last_active > mapped.started_at);
  assert.equal(typeof mapped.message_count, 'number');
});

test('a turn item becomes a renderable message', () => {
  const mapped = toGatewayMessage({ id: 'it_1', type: 'agentMessage', text: 'hello', createdAt: 1786000000000 });
  assert.equal(mapped.role, 'assistant');
  assert.deepEqual(mapped.content, [{ type: 'text', text: 'hello' }]);
});

test('agent deltas and terminal events normalize', () => {
  assert.equal(
    normalizeCodexEvent({ method: 'item/agentMessage/delta', params: { delta: 'hi', threadId: 't' } }).type,
    'message.delta',
  );
  assert.equal(normalizeCodexEvent({ method: 'turn/completed', params: { threadId: 't' } }).type, 'run.completed');
  assert.equal(normalizeCodexEvent({ method: 'error', params: { message: 'boom' } }).type, 'run.failed');
  assert.equal(
    normalizeCodexEvent({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { input: 1 } } }).type,
    'usage',
  );
});

test('reasoning summary deltas normalize as live thinking', () => {
  const event = normalizeCodexEvent({
    method: 'item/reasoning/summaryTextDelta',
    params: { threadId: 't', delta: 'checking the route' },
  });
  assert.deepEqual(event, {
    type: 'message.reasoning.delta',
    payload: { text: 'checking the route', threadId: 't' },
  });
});

test('command and patch items are tool events; plain messages are not', () => {
  const started = normalizeCodexEvent({
    method: 'item/started',
    params: { item: { id: 'i1', type: 'commandExecution' } },
  });
  assert.equal(started.type, 'tool.started');

  const output = normalizeCodexEvent({
    method: 'item/commandExecution/outputDelta',
    params: { itemId: 'i1', delta: 'file.txt\n' },
  });
  assert.equal(output.type, 'tool.progress');
  assert.equal(output.payload.callId, 'i1');
  assert.equal(output.payload.text, 'file.txt\n');

  const plain = normalizeCodexEvent({ method: 'item/started', params: { item: { id: 'i2', type: 'agentMessage' } } });
  assert.notEqual(plain.type, 'tool.started');
});

test('an output delta arriving as a byte array is decoded', () => {
  const bytes = [...Buffer.from('hello')];
  const event = normalizeCodexEvent({ method: 'process/outputDelta', params: { chunk: bytes } });
  assert.equal(event.payload.text, 'hello');
});

test('tool start exposes its command and failed completion preserves the error', () => {
  const started = normalizeCodexEvent({
    method: 'item/started',
    params: { item: { id: 'i1', type: 'commandExecution', command: 'rg TODO' } },
  });
  assert.equal(started.payload.input, 'rg TODO');

  const failed = normalizeCodexEvent({
    method: 'item/completed',
    params: { item: {
      id: 'i1', type: 'commandExecution', status: 'failed', aggregatedOutput: 'permission denied',
    } },
  });
  assert.equal(failed.type, 'tool.output');
  assert.equal(failed.payload.isError, true);
  assert.equal(failed.payload.output, 'permission denied');
});

test('an unknown notification is a diagnostic', () => {
  assert.equal(normalizeCodexEvent({ method: 'account/updated', params: {} }).type, 'diagnostic');
});

test('approval server-requests are recognised', () => {
  assert.equal(isApprovalRequest('execCommandApproval'), true);
  assert.equal(isApprovalRequest('applyPatchApproval'), true);
  assert.equal(isApprovalRequest('turn/started'), false);
});

test('sessions are listed and created scoped to the workspace', async () => {
  const { calls, rpc } = stubRpc({
    'thread/list': { threads: [{ id: 'th_1', name: 'One', createdAt: 1 }] },
    'thread/start': { threadId: 'th_new' },
  });
  const backend = createCodexBackend({ rpc, cwd: 'C:\\ws' });

  const listed = await backend.listSessions();
  assert.equal(listed[0].id, 'th_1');
  assert.equal(calls[0].params.cwd, 'C:\\ws', 'listing must be scoped to the workspace');

  const created = await backend.createSession({ title: 'New' });
  assert.equal(created.id, 'th_new');
  assert.equal(calls[1].params.cwd, 'C:\\ws');
  assert.equal(calls[2].method, 'thread/name/set');
});

test('sending a turn passes input and workspace, and records the turn for interrupt', async () => {
  // This case used to build a backend with no `subscribe` at all and take the
  // reply for granted. That is the defect itself: with no bus to watch, the
  // Gate cannot know the turn finished, so there is nothing to publish but a
  // silent turn. It is subscribed now, and completes.
  const handlers = new Set();
  const { calls, rpc } = stubRpc({
    'turn/start': () => {
      setTimeout(() => {
        for (const handler of handlers) handler({ method: 'turn/completed', params: { threadId: 'th_1' } });
      }, 1);
      return { turnId: 'tu_1' };
    },
    'turn/interrupt': {},
  });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws',
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
  });
  await backend.sendMessage('th_1', { text: 'do it', model: { modelId: 'gpt-5.6' } });
  assert.deepEqual(calls[0].params.input, [{ type: 'text', text: 'do it' }]);
  assert.equal(calls[0].params.model, 'gpt-5.6');
  await backend.abort('th_1');
  assert.equal(calls[1].params.turnId, 'tu_1', 'interrupt must target the live turn');
});

test('a native voice append waits for all active typed sends and gates later sends on that thread', async () => {
  const handlers = new Set();
  let acceptSecond;
  const secondStart = new Promise((resolve) => { acceptSecond = resolve; });
  let acknowledgeInject;
  const injectAck = new Promise((resolve) => { acknowledgeInject = resolve; });
  const { calls, rpc } = stubRpc({
    'turn/start': ({ input: [{ text }] }) => text === 'second' ? secondStart : { turn: { id: text } },
    'thread/inject_items': () => injectAck,
  });
  const backend = createCodexBackend({
    rpc,
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
  });
  const send = (text, threadId = 'th_1') => backend.sendMessage(threadId, { text, model: { modelId: 'fixture' } });
  const complete = (id, threadId = 'th_1') => {
    for (const handler of handlers) {
      handler({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
    }
  };
  const requests = () => calls.map(({ method, params }) => params.input?.[0]?.text ?? method);

  const first = send('first');
  const second = send('second');
  const appending = backend.appendVoiceExchange('th_1', { user: 'call question', assistant: 'call answer' });
  const later = send('later');
  const other = send('other', 'th_2');
  await flushTurn();
  assert.deepEqual(requests(), ['first', 'second', 'other'], 'ordinary sends start concurrently');

  complete('other', 'th_2');
  complete('first');
  await Promise.all([first, other]);
  acceptSecond({ turn: { id: 'second' } });
  await flushTurn();
  assert.deepEqual(requests(), ['first', 'second', 'other'], 'the first completion does not release the second send');

  complete('second');
  await second;
  await flushTurn();
  assert.deepEqual(requests(), ['first', 'second', 'other', 'thread/inject_items'], 'later sends wait for the inject acknowledgement');

  acknowledgeInject({});
  assert.equal(await appending, true);
  await flushTurn();
  assert.deepEqual(requests(), ['first', 'second', 'other', 'thread/inject_items', 'later']);
  complete('later');
  await later;
});

// turn/start only means "accepted"; the answer arrives as notifications.
test('a turn is awaited to completion and its deltas assembled', async () => {
  let emit = () => {};
  const { rpc } = stubRpc({ 'turn/start': () => { setTimeout(() => {
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'codex ' } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'ok' } });
    emit({ method: 'turn/completed', params: { threadId: 'th_1' } });
  }, 5); return { turnId: 'tu_1' }; } });

  const backend = createCodexBackend({
    rpc,
    cwd: 'C:\\ws',
    subscribe: (handler) => { emit = handler; return () => { emit = () => {}; }; },
  });
  const result = await backend.sendMessage('th_1', { text: 'hi' });
  assert.equal(result.text, 'codex ok');
  assert.equal(result.message.role, 'assistant');
});

test('a failed turn rejects rather than returning empty text', async () => {
  let emit = () => {};
  const { rpc } = stubRpc({ 'turn/start': () => { setTimeout(() => {
    emit({ method: 'error', params: { threadId: 'th_1', message: 'model unavailable' } });
  }, 5); return { turnId: 'tu_1' }; } });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws',
    subscribe: (handler) => { emit = handler; return () => {}; },
  });
  await assert.rejects(() => backend.sendMessage('th_1', { text: 'hi' }), /model unavailable/);
});

test('deltas for another thread are not folded into this turn', async () => {
  let emit = () => {};
  const { rpc } = stubRpc({ 'turn/start': () => { setTimeout(() => {
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_OTHER', delta: 'nope' } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'mine' } });
    emit({ method: 'turn/completed', params: { threadId: 'th_1' } });
  }, 5); return { turnId: 'tu_1' }; } });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws',
    subscribe: (handler) => { emit = handler; return () => {}; },
  });
  assert.equal((await backend.sendMessage('th_1', { text: 'hi' })).text, 'mine');
});

// A turn the app-server accepted and then never finished is not an answer.
// `awaitTurn` resolves `{completed: false}` when its bound runs out, and
// `sendMessage` used to ignore that flag and build a reply from whatever text had
// arrived — so a turn slower than three minutes was published to the phone as a
// complete reply with `finish_reason: stop` while the app-server was still
// running it, and the model-health table scored the silence as a success.
test('a turn that never completes is not published as a finished answer', { timeout: 5_000 }, async (t) => {
  keepEventLoopAlive(t);
  let emit = () => {};
  const { calls, rpc } = stubRpc({ 'turn/start': () => { setTimeout(() => {
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'half an ans' } });
  }, 5); return { turnId: 'tu_1' }; } });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws', turnTimeoutMs: 40,
    subscribe: (handler) => { emit = handler; return () => { emit = () => {}; }; },
  });

  await assert.rejects(
    () => backend.sendMessage('th_1', { text: 'refactor everything' }),
    (error) => {
      assert.match(error.message, /did not answer within/i, 'a cut-short turn is named, not answered');
      assert.doesNotMatch(error.message, /half an ans/, 'and the fragment is not passed off as the answer');
      return true;
    },
  );
  const interrupt = calls.filter((call) => call.method === 'turn/interrupt');
  assert.equal(interrupt.length, 1, 'the app-server keeps working unless the turn is stopped');
  assert.equal(interrupt[0].params.turnId, 'tu_1', 'and the stop targets the live turn');
});

// The bound is an idle bound, not a stopwatch on the send: a turn that is still
// streaming is working, and cutting it off at three minutes published a fragment
// as the answer. The clock restarts on every sign of life, so progress at 179 s
// keeps the turn alive past 180 s.
test('progress restarts the idle bound, so a still-talking turn is not cut off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  let emit = () => {};
  const { calls, rpc } = stubRpc({ 'turn/start': { turnId: 'tu_1' }, 'turn/interrupt': {} });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws', turnTimeoutMs: 1_000,
    subscribe: (handler) => { emit = handler; return () => { emit = () => {}; }; },
  });

  const turn = backend.sendMessage('th_1', { text: 'build it' });
  await flushTurn();

  // Just short of the bound, then past the send-time deadline: the delta is a
  // sign of life, so the turn is still alive at 1.6x the bound.
  t.mock.timers.tick(800);
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'still ' } });
  await flushTurn();
  t.mock.timers.tick(800);
  await flushTurn();
  assert.equal(
    calls.some((call) => call.method === 'turn/interrupt'), false,
    'a turn that spoke inside the bound must not be stopped for silence',
  );

  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'working' } });
  emit({ method: 'turn/completed', params: { threadId: 'th_1' } });
  const result = await turn;
  assert.equal(result.text, 'still working');
  assert.equal(calls.some((call) => call.method === 'turn/interrupt'), false);
});

// The app-server documents the order item/started -> requestApproval ->
// serverRequest/resolved -> item/completed for a command that needs a ruling,
// and sends nothing at all while it waits for that ruling. So an item that is
// open is either executing or parked on the operator: either way it is not idle,
// and the approval wait must not consume the turn's budget.
test('a command waiting on approval suspends the idle bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  let emit = () => {};
  const { calls, rpc } = stubRpc({ 'turn/start': { turnId: 'tu_1' }, 'turn/interrupt': {} });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws', turnTimeoutMs: 1_000,
    subscribe: (handler) => { emit = handler; return () => { emit = () => {}; }; },
  });

  const turn = backend.sendMessage('th_1', { text: 'rm -rf build' });
  await flushTurn();

  const command = { id: 'cmd_1', type: 'commandExecution', command: 'rm -rf build' };
  emit({ method: 'item/started', params: { threadId: 'th_1', item: command } });
  await flushTurn();
  // Ten times the bound passes while the approval card is unanswered.
  t.mock.timers.tick(10_000);
  await flushTurn();
  assert.equal(
    calls.some((call) => call.method === 'turn/interrupt'), false,
    'an approval that has not been ruled on must not spend the idle budget',
  );

  // The operator approves: the command runs, its item closes and the turn ends.
  emit({ method: 'serverRequest/resolved', params: { threadId: 'th_1', requestId: 99 } });
  emit({
    method: 'item/completed',
    params: { threadId: 'th_1', item: { ...command, status: 'completed', aggregatedOutput: 'removed\n' } },
  });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'done' } });
  emit({ method: 'turn/completed', params: { threadId: 'th_1' } });

  const result = await turn;
  assert.equal(result.text, 'done');
  assert.equal(calls.some((call) => call.method === 'turn/interrupt'), false);
});

test('the idle bound resumes once the open item closes, and still stops a silent turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  let emit = () => {};
  const { calls, rpc } = stubRpc({ 'turn/start': { turnId: 'tu_1' }, 'turn/interrupt': {} });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws', turnTimeoutMs: 1_000,
    subscribe: (handler) => { emit = handler; return () => { emit = () => {}; }; },
  });

  const turn = backend.sendMessage('th_1', { text: 'write it' });
  const settled = turn.then(() => 'answered', (error) => error);
  await flushTurn();

  const patch = { id: 'patch_1', type: 'fileChange', status: 'inProgress' };
  emit({ method: 'item/started', params: { threadId: 'th_1', item: patch } });
  await flushTurn();
  t.mock.timers.tick(5_000);
  await flushTurn();
  assert.equal(calls.some((call) => call.method === 'turn/interrupt'), false, 'open item: not idle');

  // The operator declines; the item closes and nothing else is said. From here
  // the full idle budget applies again, and a turn that stays silent is stopped.
  emit({
    method: 'item/completed',
    params: { threadId: 'th_1', item: { ...patch, status: 'declined' } },
  });
  await flushTurn();
  t.mock.timers.tick(1_000);
  await flushTurn();

  const outcome = await settled;
  assert.match(outcome.message, /did not answer within/i, 'silence after the ruling is still a silent turn');
  const interrupt = calls.filter((call) => call.method === 'turn/interrupt');
  assert.equal(interrupt.length, 1, 'and the app-server turn is stopped with it');
  assert.equal(interrupt[0].params.turnId, 'tu_1');
});

test('a failed turn still rejects, and the stop path leaves no subscription behind', async () => {
  // Stop ends the phone's turn, so the backend has to release its subscription
  // and interrupt the app-server's turn itself: nothing else in the Gate calls
  // abort(), so a dropped signal used to leave the turn writing into a bus
  // nobody was reading for the rest of its own bound.
  const handlers = new Set();
  const { calls, rpc } = stubRpc({
    'turn/start': () => { setTimeout(() => {
      for (const handler of handlers) {
        handler({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'working' } });
      }
    }, 5); return { turnId: 'tu_1' }; },
    'turn/interrupt': {},
  });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws', turnTimeoutMs: 10_000,
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
  });
  const caller = new AbortController();

  const turn = backend.sendMessage('th_1', { text: 'hi', signal: caller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(handlers.size, 1, 'the turn is watching the bus before it starts');

  caller.abort();
  const error = await turn.then(() => null, (thrown) => thrown);

  assert.equal(error?.name, 'AbortError', 'a stopped turn is a cancellation, not a failed run');
  assert.equal(handlers.size, 0, 'and its subscription is released at once');
  const interrupt = calls.filter((call) => call.method === 'turn/interrupt');
  assert.equal(interrupt.length, 1, 'the app-server turn is stopped with it');
  assert.equal(interrupt[0].params.turnId, 'tu_1');
});

test('a turn handed an already-aborted signal never runs', async () => {
  const handlers = new Set();
  const { calls, rpc } = stubRpc({ 'turn/start': { turnId: 'tu_1' }, 'turn/interrupt': {} });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws', turnTimeoutMs: 10_000,
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
  });

  const error = await backend
    .sendMessage('th_1', { text: 'hi', signal: AbortSignal.abort() })
    .then(() => null, (thrown) => thrown);

  assert.equal(error?.name, 'AbortError');
  assert.equal(handlers.size, 0, 'no subscription is left on the bus');
  assert.equal(calls.at(-1).method, 'turn/interrupt', 'and the turn that was accepted is stopped');
});

test('history is flattened out of turns', async () => {
  const { rpc } = stubRpc({
    'thread/read': {
      turns: [
        { items: [{ id: 'i1', type: 'userMessage', role: 'user', text: 'hi' }] },
        { items: [{ id: 'i2', type: 'agentMessage', role: 'assistant', text: 'hello' }, { id: 'i3', type: 'commandExecution' }] },
      ],
    },
  });
  const backend = createCodexBackend({ rpc, cwd: 'C:\\ws' });
  const messages = await backend.listMessages('th_1');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
});

test('models come from the native list', async () => {
  const { rpc } = stubRpc({ 'model/list': { models: [{ id: 'gpt-5.6', displayName: 'GPT-5.6' }] } });
  const backend = createCodexBackend({ rpc, cwd: 'C:\\ws' });
  const models = await backend.listModels();
  assert.equal(models[0].id, 'gpt-5.6');
  assert.equal(models[0].label, 'GPT-5.6');
});

// Codex actually paginates under `data` — reading only `models`/`threads`
// silently produced empty lists against the real app-server.
test('paginated `data` results are unwrapped for models and threads', async () => {
  const { rpc } = stubRpc({
    'model/list': { data: [{ id: 'gpt-5.5', displayName: 'GPT-5.5' }] },
    'thread/list': { data: [{ id: 'th_1', name: 'One', createdAt: 1 }] },
  });
  const backend = createCodexBackend({ rpc, cwd: 'C:\\ws' });
  assert.equal((await backend.listModels())[0].id, 'gpt-5.5');
  assert.equal((await backend.listSessions())[0].id, 'th_1');
});

test('an unexpected result shape yields an empty list rather than throwing', async () => {
  const { rpc } = stubRpc({ 'model/list': { unexpected: true } });
  const backend = createCodexBackend({ rpc, cwd: 'C:\\ws' });
  assert.deepEqual(await backend.listModels(), []);
});

test('the subscription filters notifications to its own thread', () => {
  const backend = createCodexBackend({ rpc: stubRpc().rpc, cwd: 'C:\\ws' });
  const seen = [];
  const handler = backend.subscribe('th_1', (e) => seen.push(e.type));
  handler({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'a' } });
  handler({ method: 'item/agentMessage/delta', params: { threadId: 'th_OTHER', delta: 'b' } });
  assert.deepEqual(seen, ['message.delta'], 'another thread must not leak into this stream');
});

test('an unset model selects the account-supported catalog default', async () => {
  let emit = () => {};
  const { calls, rpc } = stubRpc({
    'model/list': { data: [
      { id: 'gpt-6-sol', hidden: true, isDefault: true },
      { id: 'gpt-5.6-luna', hidden: false },
      { id: 'gpt-5.6-sol', hidden: false, isDefault: true },
    ] },
    'turn/start': () => {
      setTimeout(() => emit({ method: 'turn/completed', params: { threadId: 'th_1' } }), 0);
      return { turnId: 'tu_1' };
    },
  });
  const backend = createCodexBackend({
    rpc, cwd: 'C:\\ws',
    subscribe: (handler) => { emit = handler; return () => {}; },
  });
  await backend.sendMessage('th_1', { text: 'hi' });
  assert.equal(calls[0].method, 'model/list');
  assert.equal(calls[1].params.model, 'gpt-5.6-sol');
});

test('streamEvents subscribes before a turn and releases on abort', async () => {
  const handlers = new Set();
  const backend = createCodexBackend({
    rpc: stubRpc().rpc, cwd: 'C:\\ws',
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
  });
  const controller = new AbortController();
  const seen = [];
  const stream = backend.streamEvents('th_1', (event) => seen.push(event), controller.signal);
  assert.equal(handlers.size, 1);
  for (const handler of handlers) {
    handler({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'th_1', delta: 'thinking' } });
    handler({ method: 'item/started', params: { threadId: 'th_other', item: { type: 'commandExecution' } } });
  }
  controller.abort();
  await stream;
  assert.deepEqual(seen.map((event) => event.type), ['message.reasoning.delta']);
  assert.equal(handlers.size, 0);
});
