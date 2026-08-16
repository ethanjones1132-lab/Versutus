import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOpenCodeBackend,
  normalizeOpenCodeEvent,
  toGatewaySession,
  toGatewayMessage,
} from '../core/cli-environments/backends/opencode.mjs';

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

test('a non-text delta field is not treated as message text', () => {
  const event = normalizeOpenCodeEvent({
    type: 'message.part.delta',
    properties: { sessionID: 'ses_abc', field: 'reasoning', delta: 'thinking' },
  });
  assert.notEqual(event?.type, 'message.delta');
});

test('a pending tool part becomes tool.started and a completed one tool.output', () => {
  const started = normalizeOpenCodeEvent({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_abc', part: { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'pending' } } },
  });
  assert.equal(started.type, 'tool.started');
  assert.equal(started.payload.name, 'read');

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
  assert.deepEqual(calls[0].body, {
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
