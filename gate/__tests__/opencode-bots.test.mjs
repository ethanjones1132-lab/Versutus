import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';
import {
  isBotAgent,
  isFreeModel,
  renderAgentFile,
  resolveModelPin,
  toPublicAgentBot,
} from '../core/cli-environments/opencode-agents.mjs';

// Shapes captured live from opencode 1.18.34: GET /agent, GET /config/providers.
const BUILTIN = { name: 'build', native: true, mode: 'primary', description: 'The default agent.' };
const SUBAGENT = { name: 'helper', native: false, mode: 'subagent' };
const SCOUT = {
  name: 'scout',
  native: false,
  mode: 'primary',
  description: 'Scout, a test agent',
  model: { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' },
  prompt: 'You are Scout.',
};
const PROVIDERS = {
  default: { opencode: 'big-pickle' },
  providers: [{
    id: 'opencode',
    name: 'OpenCode Zen',
    models: {
      'mimo-v2.6-flash-free': { cost: { input: 0, output: 0 }, status: 'active' },
      'big-pickle': { cost: { input: 0, output: 0 }, status: 'active' },
      'old-free': { cost: { input: 0, output: 0 }, status: 'deprecated' },
      'gpt-paid': { cost: { input: 1, output: 3 }, status: 'active' },
    },
  }],
};

/**
 * A fake OpenCode server plus an in-memory agents directory. `agents` is what
 * GET /agent returns; a write to the directory only shows up after a dispose,
 * as on the real server.
 */
function fakeServer({ agents = [BUILTIN, SCOUT], busy = {}, loadsNew = true } = {}) {
  const calls = [];
  // The fake treats the agents directory as POSIX, whatever the host OS joins
  // paths with, so the assertions below can stay plain POSIX paths.
  const norm = (path) => String(path).replaceAll('\\', '/');
  const files = new Map();
  const fileStore = {
    get size() { return files.size; },
    get: (path) => files.get(norm(path)),
    set: (path, data) => { files.set(norm(path), data); return fileStore; },
    has: (path) => files.has(norm(path)),
    delete: (path) => files.delete(norm(path)),
  };
  let live = [...agents];
  let pending = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const json = (value) => ({ ok: true, status: 200, async json() { return value; }, async text() { return JSON.stringify(value); } });
    if (path === '/agent') return json(live);
    if (path === '/config/providers') return json(PROVIDERS);
    if (path === '/session/status') return json(busy);
    if (path === '/path') return json({ config: '/cfg/opencode' });
    if (path === '/global/dispose') {
      if (loadsNew) live = [...live, ...pending];
      pending = [];
      return json(true);
    }
    if (path === '/session' && method === 'GET') {
      return json([
        { id: 'ses_1', title: 'a', agent: 'scout', time: {} },
        { id: 'ses_2', title: 'b', agent: 'build', time: {} },
      ]);
    }
    if (path === '/session' && method === 'POST') return json({ id: 'ses_new', agent: body.agent, title: body.title, time: {} });
    if (path.endsWith('/message') && method === 'POST') {
      return json({ info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] });
    }
    return { ok: false, status: 404, async text() { return 'not found'; } };
  };
  const io = {
    ensureDir: async () => {},
    writeFile: async (path, data) => {
      const key = norm(path);
      files.set(key, data);
      const name = key.replace(/^.*\//, '').replace(/\.md$/, '');
      const prior = live.find((agent) => agent.name === name);
      if (prior) {
        live = live.filter((agent) => agent !== prior);
        pending.push({ ...prior, description: /description: "([^"]*)"/.exec(data)?.[1] ?? prior.description, prompt: data.split('---\n').pop().trim() });
      } else {
        const model = /model: "([^"]+)"/.exec(data)?.[1] ?? '';
        const [providerID, modelID] = model.split('/');
        pending.push({
          name,
          native: false,
          mode: 'primary',
          description: /description: "([^"]*)"/.exec(data)?.[1] ?? '',
          model: { providerID, modelID },
          prompt: data.split('---\n').pop().trim(),
        });
      }
    },
    readText: async (path) => {
      if (!files.has(norm(path))) throw new Error('ENOENT');
      return files.get(norm(path));
    },
    removeFile: async (path) => { files.delete(norm(path)); },
  };
  return { calls, files: fileStore, fetchImpl, io };
}

function backendFor(server, options = {}) {
  return createOpenCodeBackend({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: server.fetchImpl, ...server.io, ...options });
}

test('only primary, non-built-in agents are Bots', () => {
  assert.equal(isBotAgent(BUILTIN), false);
  assert.equal(isBotAgent(SUBAGENT), false);
  assert.equal(isBotAgent(SCOUT), true);
  assert.equal(isBotAgent(undefined), false);
});

test('a model is free only when both directions cost nothing and it is not retired', () => {
  assert.equal(isFreeModel({ cost: { input: 0, output: 0 } }), true);
  assert.equal(isFreeModel({ cost: { input: 0, output: 0 }, status: 'deprecated' }), false);
  assert.equal(isFreeModel({ cost: { input: 0.15, output: 0.6 } }), false);
  assert.equal(isFreeModel({}), false);
});

test('the roster lists Bots with the same shape as a Hermes Bot, plus the runtime', async () => {
  const backend = backendFor(fakeServer({ agents: [BUILTIN, SUBAGENT, SCOUT] }));
  const roster = await backend.listBots();
  assert.deepEqual(roster, {
    object: 'list',
    data: [{
      id: 'scout',
      displayName: 'scout',
      routable: true,
      routingIssue: null,
      description: 'Scout, a test agent',
      model: { default: 'mimo-v2.6-flash-free', provider: 'opencode' },
      runtime: 'opencode',
    }],
  });
});

test('getBot adds the soul and refuses an unknown or built-in agent', async () => {
  const backend = backendFor(fakeServer());
  assert.equal((await backend.getBot({ id: 'scout' })).soul, 'You are Scout.');
  await assert.rejects(backend.getBot({ id: 'nobody' }), { code: 'unknown_bot', status: 404 });
  await assert.rejects(backend.getBot({ id: 'build' }), { code: 'unknown_bot', status: 404 });
});

test('createBot writes an agent file pinned to a free model, reloads, and returns the row', async () => {
  const server = fakeServer();
  const backend = backendFor(server);
  const created = await backend.createBot({
    name: 'pathfinder',
    soul: 'You find paths.',
    description: 'Finds paths',
    modelId: 'mimo-v2.6-flash-free',
  });
  assert.equal(created.id, 'pathfinder');
  assert.equal(created.runtime, 'opencode');
  assert.deepEqual(created.model, { default: 'mimo-v2.6-flash-free', provider: 'opencode' });
  const written = server.files.get('/cfg/opencode/agents/pathfinder.md');
  assert.match(written, /^---\ndescription: "Finds paths"\nmode: primary\nmodel: "opencode\/mimo-v2\.6-flash-free"\n---\nYou find paths\.\n$/);
  assert.ok(server.calls.includes('POST /global/dispose'), 'the server was asked to reload');
});

test('createBot with no model pins the server default when it is free', async () => {
  const server = fakeServer();
  const created = await backendFor(server).createBot({ name: 'quiet' });
  assert.equal(created.model.default, 'big-pickle');
});

test('createBot refuses a paid, retired or unknown model and writes nothing', async () => {
  for (const [modelId, code] of [['gpt-paid', 'model_not_free'], ['old-free', 'model_not_free'], ['nope', 'unknown_model']]) {
    const server = fakeServer();
    await assert.rejects(backendFor(server).createBot({ name: 'x1', modelId }), { code, status: 400 });
    assert.equal(server.files.size, 0, `${modelId} must not reach disk`);
  }
});

test('createBot refuses a taken name, whatever kind of agent holds it', async () => {
  const server = fakeServer();
  const backend = backendFor(server);
  await assert.rejects(backend.createBot({ name: 'scout' }), { code: 'bot_exists', status: 409 });
  await assert.rejects(backend.createBot({ name: 'build' }), { code: 'bot_exists', status: 409 });
  await assert.rejects(backend.createBot({ name: 'default' }), { code: 'invalid_bot_name', status: 400 });
  await assert.rejects(backend.createBot({ name: '../escape' }), { code: 'invalid_bot_name', status: 400 });
  assert.equal(server.files.size, 0);
});

test('createBot will not interrupt a running turn, and leaves no file behind', async () => {
  const server = fakeServer({ busy: { ses_1: { type: 'busy' } } });
  await assert.rejects(backendFor(server).createBot({ name: 'later' }), { code: 'backend_busy', status: 409 });
  assert.equal(server.files.size, 0);
  assert.equal(server.calls.includes('POST /global/dispose'), false);
});

test('createBot removes its file when the server never loads the agent', async () => {
  const server = fakeServer({ loadsNew: false });
  await assert.rejects(backendFor(server).createBot({ name: 'ghost' }), { code: 'bot_create_failed', status: 502 });
  assert.equal(server.files.size, 0);
});

test('a Gate that allows paid models says so explicitly', async () => {
  const server = fakeServer();
  const created = await backendFor(server, { freeOnly: false }).createBot({ name: 'big-spender', modelId: 'gpt-paid' });
  assert.equal(created.model.default, 'gpt-paid');
});

test('updateBot rewrites the file, keeps the pin it is not given, and rolls back on a failed reload', async () => {
  const server = fakeServer();
  const backend = backendFor(server);
  server.files.set('/cfg/opencode/agents/scout.md', renderAgentFile({
    description: 'Scout, a test agent', providerId: 'opencode', modelId: 'mimo-v2.6-flash-free', soul: 'You are Scout.',
  }));
  const updated = await backend.updateBot({ id: 'scout', soul: 'You are Scout, reborn.' });
  assert.equal(updated.id, 'scout');
  assert.match(server.files.get('/cfg/opencode/agents/scout.md'), /model: "opencode\/mimo-v2\.6-flash-free"/);
  assert.match(server.files.get('/cfg/opencode/agents/scout.md'), /You are Scout, reborn\./);

  const original = server.files.get('/cfg/opencode/agents/scout.md');
  const busy = fakeServer({ busy: { ses_1: {} } });
  busy.files.set('/cfg/opencode/agents/scout.md', original);
  await assert.rejects(backendFor(busy).updateBot({ id: 'scout', soul: 'changed' }), { code: 'backend_busy' });
  assert.equal(busy.files.get('/cfg/opencode/agents/scout.md'), original, 'a refused reload restores the file');
});

test('updateBot refuses a paid pin and an agent that is not a file, and ignores a cleared pin', async () => {
  const server = fakeServer();
  const backend = backendFor(server);
  server.files.set('/cfg/opencode/agents/scout.md', renderAgentFile({ description: '', providerId: 'opencode', modelId: 'big-pickle', soul: '' }));
  await assert.rejects(backend.updateBot({ id: 'scout', modelId: 'gpt-paid' }), { code: 'model_not_free' });
  const kept = await backend.updateBot({ id: 'scout', modelId: null, providerId: null, soul: 'still here' });
  assert.match(server.files.get('/cfg/opencode/agents/scout.md'), /model: "opencode\/mimo-v2\.6-flash-free"/, 'the live pin is kept');
  assert.equal(kept.id, 'scout');
  server.files.delete('/cfg/opencode/agents/scout.md');
  await assert.rejects(backend.updateBot({ id: 'scout', soul: 'x' }), { code: 'bot_not_editable', status: 409 });
  await assert.rejects(backend.updateBot({ id: 'nobody', soul: 'x' }), { code: 'unknown_bot' });
});

test('forBot scopes sessions and turns to the agent', async () => {
  const server = fakeServer();
  const scoped = await backendFor(server).forBot('scout');
  const sessions = await scoped.listSessions();
  assert.deepEqual(sessions.map((session) => session.id), ['ses_1'], 'only the Bot\'s own sessions');

  await scoped.createSession({ title: 'hello' });
  const created = server.calls.indexOf('POST /session');
  assert.ok(created >= 0);
  await scoped.sendMessage('ses_new', { text: 'hi' });
});

test('forBot sends the agent on every session and turn', async () => {
  const bodies = [];
  const server = fakeServer();
  const inner = server.fetchImpl;
  server.fetchImpl = async (url, init = {}) => {
    if (init.body) bodies.push({ path: String(url).replace(/^https?:\/\/[^/]+/, ''), body: JSON.parse(init.body) });
    return inner(url, init);
  };
  const scoped = await backendFor(server).forBot('scout');
  await scoped.createSession({ title: 'hello' });
  await scoped.sendMessage('ses_new', { text: 'hi' });
  assert.equal(bodies.find((entry) => entry.path === '/session').body.agent, 'scout');
  assert.equal(bodies.find((entry) => entry.path.endsWith('/message')).body.agent, 'scout');
});

test('forBot refuses a paid model on a turn or a new session', async () => {
  const scoped = await backendFor(fakeServer()).forBot('scout');
  const paid = { providerId: 'opencode', modelId: 'gpt-paid' };
  await assert.rejects(scoped.sendMessage('ses_new', { text: 'hi', model: paid }), { code: 'model_not_free' });
  await assert.rejects(scoped.createSession({ title: 't', model: paid }), { code: 'model_not_free' });
  const free = { providerId: 'opencode', modelId: 'mimo-v2.6-flash-free' };
  assert.equal((await scoped.sendMessage('ses_new', { text: 'hi', model: free })).text, 'ok');
});

test('forBot refuses an unknown Bot with unknown_bot so the Gate can try another runtime', async () => {
  await assert.rejects(backendFor(fakeServer()).forBot('nobody'), { code: 'unknown_bot', status: 404 });
  await assert.rejects(backendFor(fakeServer()).forBot('build'), { code: 'unknown_bot', status: 404 });
});

test('listModels drops retired models and marks which are free', async () => {
  const models = await backendFor(fakeServer()).listModels();
  const ids = models.map((model) => model.modelId);
  assert.equal(ids.includes('old-free'), false);
  assert.equal(models.find((model) => model.modelId === 'gpt-paid').free, false);
  assert.equal(models.find((model) => model.modelId === 'mimo-v2.6-flash-free').free, true);
});

test('resolveModelPin accepts provider/model in modelId', () => {
  const rows = [{ providerId: 'opencode', modelId: 'big-pickle', free: true }];
  assert.deepEqual(resolveModelPin({ modelId: 'opencode/big-pickle' }, rows), { providerId: 'opencode', modelId: 'big-pickle' });
  assert.throws(() => resolveModelPin({}, []), { code: 'no_free_model' });
});

test('an agent file never lets a description or soul break out of its frontmatter', () => {
  const file = renderAgentFile({
    description: 'line one\n---\nmode: subagent',
    providerId: 'opencode',
    modelId: 'big-pickle',
    soul: 'You are fine.',
  });
  const frontmatter = file.split('\n---\n')[0];
  assert.equal(frontmatter.split('\n').length, 4, 'a newline in the description stays on one quoted line');
  assert.equal(toPublicAgentBot(SCOUT).runtime, 'opencode');
});
