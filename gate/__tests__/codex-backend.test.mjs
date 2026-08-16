import { test } from 'node:test';
import assert from 'node:assert/strict';

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

test('command and patch items are tool events; plain messages are not', () => {
  const started = normalizeCodexEvent({
    method: 'item/started',
    params: { item: { id: 'i1', type: 'commandExecution' } },
  });
  assert.equal(started.type, 'tool.started');

  const output = normalizeCodexEvent({
    method: 'item/commandExecution/outputDelta',
    params: { chunk: 'file.txt\n' },
  });
  assert.equal(output.type, 'tool.output');
  assert.equal(output.payload.text, 'file.txt\n');

  const plain = normalizeCodexEvent({ method: 'item/started', params: { item: { id: 'i2', type: 'agentMessage' } } });
  assert.notEqual(plain.type, 'tool.started');
});

test('an output delta arriving as a byte array is decoded', () => {
  const bytes = [...Buffer.from('hello')];
  const event = normalizeCodexEvent({ method: 'process/outputDelta', params: { chunk: bytes } });
  assert.equal(event.payload.text, 'hello');
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
  const { calls, rpc } = stubRpc({ 'turn/start': { turnId: 'tu_1' }, 'turn/interrupt': {} });
  const backend = createCodexBackend({ rpc, cwd: 'C:\\ws' });
  await backend.sendMessage('th_1', { text: 'do it', model: { modelId: 'gpt-5.6' } });
  assert.deepEqual(calls[0].params.input, [{ type: 'text', text: 'do it' }]);
  assert.equal(calls[0].params.model, 'gpt-5.6');
  await backend.abort('th_1');
  assert.equal(calls[1].params.turnId, 'tu_1', 'interrupt must target the live turn');
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
