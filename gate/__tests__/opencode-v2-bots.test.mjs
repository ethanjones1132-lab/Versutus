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

function v2Server() {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    requests.push({ method: init.method ?? 'GET', path, auth: init.headers?.Authorization });
    if (path === '/session') return html; // the v2 probe: the SPA catch-all
    if (path === '/api/info') return json({ version: '2.2.6' });
    if (path.startsWith('/agent')) return html; // the real 2.x answer to the v1 route
    if (path.startsWith('/api/agent')) return json({ data: V2_AGENTS });
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
