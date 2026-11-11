import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';
import { fromV2Agent, isBotAgent } from '../core/cli-environments/opencode-agents.mjs';

// OpenCode 2.x serves its agent list at GET /api/agent (wrapped in {data}) and
// answers the v1 GET /agent with its web app, so a 2.x Gate listed no OpenCode
// Bots and the roster showed no OpenCode at all (verified on 2.2.6, 2026-11-10:
// `/agent` -> 200 text/html, `/api/agent` -> 401 JSON without the password).
// Agent.Info shape per anomalyco/opencode packages/schema/src/agent.ts.

const html = { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), async text() { return '<!doctype html><html></html>'; } };
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  async text() { return JSON.stringify(body); },
});

const V2_AGENTS = [
  { id: 'build', name: 'Build', mode: 'primary', hidden: false, request: {}, permissions: [] },
  { id: 'plan', name: 'Plan', mode: 'primary', hidden: false, request: {}, permissions: [] },
  { id: 'general', name: 'General', mode: 'subagent', hidden: false, request: {}, permissions: [] },
  { id: 'title', name: 'Title', mode: 'primary', hidden: true, request: {}, permissions: [] },
  {
    id: 'reviewer', name: 'Reviewer', mode: 'primary', hidden: false, request: {}, permissions: [],
    description: 'Reviews diffs', system: 'You review diffs.', model: { id: 'big-pickle', providerID: 'opencode' },
  },
  { id: 'helper', name: 'Helper', mode: 'all', hidden: false, request: {}, permissions: [] },
  { id: 'scout', name: 'Scout', mode: 'subagent', hidden: false, request: {}, permissions: [] },
];

const V2_MODELS = [
  { id: 'big-pickle', modelID: 'big-pickle', providerID: 'opencode', status: 'active', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
  { id: 'paid-one', modelID: 'paid-one', providerID: 'opencode', status: 'active', cost: [{ input: 3, output: 15, cache: { read: 0, write: 0 } }] },
  { id: 'old-free', modelID: 'old-free', providerID: 'opencode', status: 'deprecated', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
  { id: 'unpriced', modelID: 'unpriced', providerID: 'opencode', status: 'active', cost: [] },
];

const V2_SESSIONS = [
  { id: 'ses_r', title: 'review', agent: 'reviewer', time: { created: 1, updated: 2 } },
  { id: 'ses_b', title: 'plain', agent: 'build', time: { created: 1, updated: 2 } },
];

function v2Server() {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init.method ?? 'GET';
    requests.push({ method, path, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === '/session') return html; // the v2 probe: the SPA catch-all
    if (path === '/api/info') return json({ version: '2.2.6' });
    if (path.startsWith('/agent') || path.startsWith('/config/')) return html; // the real 2.x answer to v1 routes
    if (path.startsWith('/api/agent')) return json({ data: V2_AGENTS });
    if (path.startsWith('/api/model')) return json({ data: V2_MODELS });
    if (path.includes('/diff')) return json({ data: [
      { file: 'src/changed.ts', additions: 1, deletions: 1, patch: '--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -1 +1 @@\n-old\n+new' },
      { file: 'src/new.ts', additions: 1, deletions: 0, patch: '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new' },
    ] });
    if (path.startsWith('/api/session') && method === 'GET') return json({ data: V2_SESSIONS });
    if (path.startsWith('/api/session') && method === 'POST') {
      return json({ data: { id: 'ses_new', title: 'x', agent: JSON.parse(init.body ?? '{}').agent, time: { created: 3 } } });
    }
    return json({ name: 'NotFound' }, 404);
  };
  return { requests, fetchImpl };
}

test('a 2.x server lists its own agent files as Bots, read from /api/agent', async () => {
  const { requests, fetchImpl } = v2Server();
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl, password: 'test-only' });
  const roster = await backend.listBots();
  assert.deepEqual(roster.data.map((bot) => bot.id), ['reviewer', 'helper']);
  assert.ok(requests.some((request) => request.path.startsWith('/api/agent')));
  assert.equal(requests.some((request) => request.path === '/agent'), false, 'the v1 route is the web app on 2.x');
  const reviewer = roster.data.find((bot) => bot.id === 'reviewer');
  assert.deepEqual(
    { runtime: reviewer.runtime, description: reviewer.description, model: reviewer.model },
    { runtime: 'opencode', description: 'Reviews diffs', model: { default: 'big-pickle', provider: 'opencode' } },
  );
  // 2.x takes Basic auth; v1's Bearer would be refused.
  const agentRead = requests.find((request) => request.path.startsWith('/api/agent'));
  assert.match(agentRead.auth ?? '', /^Basic /);
});

test('a 2.x session diff is read from the documented diff endpoint with its workspace scope', async () => {
  const { requests, fetchImpl } = v2Server();
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl,
    password: 'test-only',
    directory: 'C:\\workspace',
  });
  const result = await backend.getSessionChanges('ses_review');
  assert.equal(result.supported, true);
  assert.deepEqual(result.files, [
    { path: 'src/changed.ts', status: 'modified', additions: 1, deletions: 1, patch: '--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -1 +1 @@\n-old\n+new' },
    { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0, patch: '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new' },
  ]);
  const diffRead = requests.find((request) => request.path.includes('/diff'));
  assert.equal(diffRead.method, 'GET');
  assert.match(diffRead.path, /^\/api\/session\/ses_review\/diff\?location\[directory\]=/);
  assert.match(diffRead.auth ?? '', /^Basic /);
});

test('a 1.x OpenCode server reports session diffs as unsupported', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    requests.push(path);
    return path === '/session' ? json([]) : json({ data: [] });
  };
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  assert.deepEqual(await backend.getSessionChanges('ses_v1'), { supported: false, files: [] });
  assert.deepEqual(requests, ['/session']);
});

test('an older 2.x server without the diff route reports unsupported for a session that exists', async () => {
  const { fetchImpl: baseFetch } = v2Server();
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path.includes('/diff')) return json({ name: 'NotFound' }, 404);
    return baseFetch(url, init);
  };
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl, password: 'test-only' });
  assert.deepEqual(await backend.getSessionChanges('ses_existing'), { supported: false, files: [] });
});

test('a 2.x getBot returns the agent system prompt as the soul and refuses a built-in', async () => {
  const { fetchImpl } = v2Server();
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const bot = await backend.getBot({ id: 'reviewer' });
  assert.equal(bot.soul, 'You review diffs.');
  await assert.rejects(backend.getBot({ id: 'build' }), (error) => error.code === 'unknown_bot');
  await assert.rejects(backend.getBot({ id: 'title' }), (error) => error.code === 'unknown_bot');
});

test('fromV2Agent marks built-in and hidden agents native and maps the model ref', () => {
  assert.equal(fromV2Agent({ id: 'build', mode: 'primary', hidden: false }).native, true);
  assert.equal(fromV2Agent({ id: 'title', mode: 'primary', hidden: true }).native, true);
  assert.equal(fromV2Agent({ id: 'mine', mode: 'primary', hidden: true }).native, true);
  const mine = fromV2Agent({ id: 'mine', mode: 'primary', hidden: false, model: { id: 'm1', providerID: 'p1' } });
  assert.equal(isBotAgent(mine), true);
  assert.deepEqual(mine.model, { modelID: 'm1', providerID: 'p1' });
  assert.equal(fromV2Agent({ name: 'no-id', mode: 'primary' }), null);
  assert.equal(fromV2Agent(null), null);
});

test('a 2.x Bot sees only its own sessions, read from Session.Info.agent', async () => {
  const { fetchImpl } = v2Server();
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const bot = await backend.forBot('reviewer');
  assert.deepEqual((await bot.listSessions()).map((session) => session.id), ['ses_r']);
});

test('a 2.x Bot opens a new session as its agent', async () => {
  const { requests, fetchImpl } = v2Server();
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const bot = await backend.forBot('reviewer');
  const created = await bot.createSession({ title: 'x' });
  const post = requests.find((request) => request.method === 'POST' && request.path.startsWith('/api/session'));
  assert.equal(post.body.agent, 'reviewer');
  assert.equal(created.bot, 'reviewer');
});

test('the free-only rule holds on 2.x: a Bot may name a free model, never a paid, retired or unpriced one', async () => {
  const { fetchImpl } = v2Server();
  const backend = createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
  const bot = await backend.forBot('reviewer');
  // createSession is where the check runs before any session exists.
  await bot.createSession({ model: { providerId: 'opencode', modelId: 'big-pickle' } });
  for (const modelId of ['paid-one', 'old-free', 'unpriced', 'not-listed']) {
    await assert.rejects(
      bot.createSession({ model: { providerId: 'opencode', modelId } }),
      (error) => error.code === 'model_not_free',
      `${modelId} must be refused`,
    );
  }
  await assert.rejects(
    backend.sendMessage('ses_r', { text: 'hi', agent: 'reviewer', model: { providerId: 'opencode', modelId: 'paid-one' } }),
    (error) => error.code === 'model_not_free',
  );
});
