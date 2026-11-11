import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';

// Creating and editing an OpenCode Bot on a 2.x server. v1's GET /path,
// /session/status, /global/dispose and /config/providers all answer 2.x with
// its web app, so every create and edit failed there. 2.x equivalents
// (anomalyco/opencode packages/protocol/src/groups): config.get GET /api/config
// (directory sources, lowest priority first), session.active GET
// /api/session/active, location.reload POST /api/location/reload, model.list
// GET /api/model, model.default GET /api/model/default. Agent files load from
// {agent,agents}/ under a config directory (packages/core/src/config/plugin/agent.ts).

const GLOBAL = join('C:', 'fake-home', '.config', 'opencode');
const WORKSPACE = join('C:', 'fake-projects', 'app');

const html = { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), async text() { return '<!doctype html>'; } };
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  async text() { return body === undefined ? '' : JSON.stringify(body); },
});
const noContent = { ok: true, status: 204, headers: new Headers(), async text() { return ''; } };

const MODELS = [
  { id: 'big-pickle', modelID: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', status: 'active', enabled: true, cost: [{ input: 0, output: 0 }] },
  { id: 'paid-one', modelID: 'paid-one', providerID: 'opencode', name: 'Paid', status: 'active', enabled: true, cost: [{ input: 3, output: 15 }] },
  { id: 'free-two', modelID: 'free-two', providerID: 'opencode', name: 'Free Two', status: 'active', enabled: true, cost: [{ input: 0, output: 0 }] },
  { id: 'retired', modelID: 'retired', providerID: 'opencode', name: 'Retired', status: 'deprecated', enabled: true, cost: [{ input: 0, output: 0 }] },
  { id: 'switched-off', modelID: 'switched-off', providerID: 'opencode', name: 'Off', status: 'active', enabled: false, cost: [{ input: 0, output: 0 }] },
];

/** Read back an agent file the way the server would load it. */
function agentFromFile(id, text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const front = Object.fromEntries(match[1].split('\n').map((line) => {
    const at = line.indexOf(':');
    const raw = line.slice(at + 1).trim();
    return [line.slice(0, at), raw.startsWith('"') ? JSON.parse(raw) : raw];
  }));
  const [providerID, ...rest] = String(front.model).split('/');
  return {
    id, name: id, mode: front.mode, hidden: false, request: {}, permissions: [],
    description: front.description, system: match[2].trim(), model: { id: rest.join('/'), providerID },
  };
}

function world({ existingDirs = [], files = {}, active = {}, defaultModel = MODELS[2], configEntries, directory = WORKSPACE, serverLocation = WORKSPACE } = {}) {
  const fsFiles = new Map(Object.entries(files));
  const dirs = new Set(existingDirs);
  const loaded = new Map();
  const requests = [];
  const load = () => {
    loaded.clear();
    for (const [path, text] of fsFiles) {
      const id = path.split(/[\\/]/).pop().replace(/\.md$/, '');
      loaded.set(id, agentFromFile(id, text));
    }
  };
  load();
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init.method ?? 'GET';
    requests.push(`${method} ${path.split('?')[0]}`);
    if (path === '/session') return html;
    if (path === '/api/info') return json({ version: '2.2.6' });
    if (!path.startsWith('/api/')) return html; // every v1 route on 2.x
    if (path.startsWith('/api/config')) {
      return json({ data: configEntries ?? [
        { type: 'directory', path: GLOBAL },
        { type: 'document', path: join(GLOBAL, 'opencode.json'), info: {} },
        { type: 'directory', path: join(WORKSPACE, '.opencode') },
      ] });
    }
    if (path === '/api/session/active') return json({ data: active });
    if (path.startsWith('/api/location') && method === 'GET') {
      return serverLocation ? json({ directory: serverLocation }) : json({ name: 'ServiceUnavailable' }, 503);
    }
    if (path === '/api/location/reload' && method === 'POST') { load(); return noContent; }
    if (path.startsWith('/api/model/default')) return json({ data: defaultModel });
    if (path.startsWith('/api/model')) return json({ data: MODELS });
    if (path.startsWith('/api/agent')) {
      return json({ data: [{ id: 'build', name: 'Build', mode: 'primary', hidden: false, request: {}, permissions: [] }, ...loaded.values()] });
    }
    return json({ name: 'NotFound' }, 404);
  };
  const backend = createOpenCodeBackend({
    baseUrl: 'http://127.0.0.1:4096',
    fetchImpl,
    directory,
    writeFile: async (path, text) => { fsFiles.set(path, text); },
    readText: async (path) => {
      if (!fsFiles.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return fsFiles.get(path);
    },
    removeFile: async (path) => { fsFiles.delete(path); },
    ensureDir: async (path) => { dirs.add(path); },
    pathExists: async (path) => dirs.has(path) || fsFiles.has(path),
  });
  return { backend, fsFiles, requests };
}

test('a 2.x Bot is created in the global config directory, reloaded, and listed', async () => {
  const { backend, fsFiles, requests } = world();
  const bot = await backend.createBot({ name: 'scribe', soul: 'You take notes.', description: 'Notes', modelId: 'big-pickle', providerId: 'opencode' });
  assert.equal(bot.id, 'scribe');
  assert.equal(bot.runtime, 'opencode');
  const [path] = [...fsFiles.keys()];
  assert.equal(path, join(GLOBAL, 'agents', 'scribe.md'), 'never inside the workspace, and agents/ when no agent/ exists');
  assert.match(fsFiles.get(path), /mode: primary/);
  assert.ok(requests.includes('GET /api/session/active'));
  assert.ok(requests.includes('POST /api/location/reload'));
  assert.equal(
    requests.some((request) => /^(GET|POST) \/(path|session\/status|global\/dispose|config\/providers)$/.test(request)),
    false,
    'no v1-only route is used on 2.x',
  );
  assert.deepEqual((await backend.listBots()).data.map((row) => row.id), ['scribe']);
});

test('a new 2.x Bot sits beside the operator agent files in agent/ when that is the only folder', async () => {
  const { backend, fsFiles } = world({ existingDirs: [join(GLOBAL, 'agent')] });
  await backend.createBot({ name: 'scribe', modelId: 'big-pickle', providerId: 'opencode' });
  assert.deepEqual([...fsFiles.keys()], [join(GLOBAL, 'agent', 'scribe.md')]);
});

test('an unpinned 2.x Bot takes the server default model when it is free', async () => {
  const { backend, fsFiles } = world();
  await backend.createBot({ name: 'scribe' });
  assert.match([...fsFiles.values()][0], /model: "opencode\/free-two"/);
});

test('a 2.x Bot cannot be created on a paid model, and nothing is written', async () => {
  const { backend, fsFiles } = world();
  await assert.rejects(
    backend.createBot({ name: 'scribe', modelId: 'paid-one', providerId: 'opencode' }),
    (error) => error.code === 'model_not_free',
  );
  assert.equal(fsFiles.size, 0);
});

test('a 2.x create waits for an idle server and leaves no file behind', async () => {
  const { backend, fsFiles, requests } = world({ active: { ses_1: { type: 'running' } } });
  await assert.rejects(
    backend.createBot({ name: 'scribe', modelId: 'big-pickle', providerId: 'opencode' }),
    (error) => error.code === 'backend_busy',
  );
  assert.equal(fsFiles.size, 0);
  assert.equal(requests.includes('POST /api/location/reload'), false);
});

test('a 2.x server with only workspace config directories is refused rather than writing into the project', async () => {
  const { backend, fsFiles } = world({ configEntries: [{ type: 'directory', path: join(WORKSPACE, '.opencode') }] });
  await assert.rejects(
    backend.createBot({ name: 'scribe', modelId: 'big-pickle', providerId: 'opencode' }),
    (error) => error.code === 'backend_unsupported',
  );
  assert.equal(fsFiles.size, 0);
});

test('a 2.x Bot defined in agent/ is edited in place and keeps its pin', async () => {
  const existing = join(GLOBAL, 'agent', 'mine.md');
  const { backend, fsFiles } = world({
    existingDirs: [join(GLOBAL, 'agent'), join(GLOBAL, 'agents')],
    files: { [existing]: '---\ndescription: "old"\nmode: primary\nmodel: "opencode/big-pickle"\n---\nOld soul.\n' },
  });
  const updated = await backend.updateBot({ id: 'mine', soul: 'New soul.' });
  assert.equal(updated.id, 'mine');
  assert.deepEqual([...fsFiles.keys()], [existing], 'rewritten where it lives, not duplicated into agents/');
  assert.match(fsFiles.get(existing), /model: "opencode\/big-pickle"/);
  assert.match(fsFiles.get(existing), /New soul\./);
  assert.equal((await backend.getBot({ id: 'mine' })).soul, 'New soul.');
});

test('the 2.x model list flags free models for the Bot picker and drops retired ones', async () => {
  const { backend } = world();
  const rows = await backend.listModels();
  assert.deepEqual(
    rows.map((row) => [row.modelId, row.free]),
    [['big-pickle', true], ['paid-one', false], ['free-two', true], ['switched-off', false]],
  );
});

test('a Gate with no workspace of its own uses the server location to keep Bots out of the project', async () => {
  // The project's .opencode sorts first here; only the server's location shows it is the project's.
  const configEntries = [{ type: 'directory', path: join(WORKSPACE, '.opencode') }, { type: 'directory', path: GLOBAL }];
  const { backend, fsFiles } = world({ directory: null, configEntries });
  await backend.createBot({ name: 'scribe', modelId: 'big-pickle', providerId: 'opencode' });
  assert.deepEqual([...fsFiles.keys()], [join(GLOBAL, 'agents', 'scribe.md')]);
});

test('with neither a workspace nor a server location, a 2.x create is refused and writes nothing', async () => {
  const { backend, fsFiles } = world({ directory: null, serverLocation: null });
  await assert.rejects(
    backend.createBot({ name: 'scribe', modelId: 'big-pickle', providerId: 'opencode' }),
    (error) => error.code === 'backend_unsupported',
  );
  assert.equal(fsFiles.size, 0);
});

test('a disabled model can be neither a Bot pin nor its default', async () => {
  const { backend, fsFiles } = world({ defaultModel: MODELS[4] });
  await assert.rejects(
    backend.createBot({ name: 'scribe', modelId: 'switched-off', providerId: 'opencode' }),
    (error) => error.code === 'model_not_free',
  );
  await backend.createBot({ name: 'scribe' });
  assert.doesNotMatch([...fsFiles.values()][0], /switched-off/);
});
