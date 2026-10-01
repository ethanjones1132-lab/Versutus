import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';
import {
  CATALOGUE_READ_TIMEOUT_MS,
  createBackendModelRouter,
  pickBackendForModel,
  qualifiedModelId,
} from '../core/backend-model-route.mjs';

// 2026-10-01: a thread on the Hermes environment whose client had lost its scope
// sent `providerId: 'kilo'` and no backendId, and the Gate answered `Unknown
// provider "kilo"` — it never asked the environments attached to it whether one
// of them serves that model, although /v1/models has always aggregated
// backend.listModels() (Hermes files its catalogue as `${providerId}/${modelId}`,
// e.g. `kilo/kilo-auto/free`). The app sends the scope again now (see
// gateway-provider's attachClient), but APKs already in the field keep sending
// the scope-less turn, so the Gate resolves it for them.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  // `maxRetries` matters here: closing a Gate writes its credential store, and
  // Windows refuses to remove a directory that is still being written to.
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

const session = (id) => ({
  id, source: 'api_server', user_id: null, model: null, title: 'Session',
  started_at: 1, ended_at: null, end_reason: null, message_count: 0, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  reasoning_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, api_call_count: 0,
  parent_session_id: null, last_active: 1, preview: null, has_system_prompt: false,
  has_model_config: false,
});

/**
 * An environment that answers a turn and owns a model catalogue, the shape
 * every CLI backend has. `models` is what it lists for the picker.
 */
function cataloguedBackend(calls, adapterId, models) {
  return {
    async listSessions(limit) { calls.push(`${adapterId}:listSessions:${limit}`); return [session(`${adapterId}_1`)]; },
    async createSession(input) {
      calls.push(`${adapterId}:createSession:${input?.model?.modelId ?? 'none'}`);
      return { ...session(`${adapterId}_new`), title: input?.title ?? null };
    },
    async deleteSession() {},
    async listMessages() { return []; },
    async sendMessage(id, input) {
      calls.push(`${adapterId}:sendMessage:${input?.model?.modelId ?? ''}`);
      return {
        text: `answered by ${adapterId}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `answered by ${adapterId}` }] },
        runtime: { model: input?.model?.modelId },
      };
    },
    async listModels() { calls.push(`${adapterId}:listModels`); return models; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
  };
}

const HERMES_MODELS = [
  { id: 'kilo/kilo-auto/free', providerId: 'kilo', modelId: 'kilo-auto/free', label: 'Kilo · auto', available: true },
  { id: 'opencode-go-session/deepseek-v4.1-flash', providerId: 'opencode-go-session', modelId: 'deepseek-v4.1-flash', label: 'Go · flash', available: true },
];

function registryFor(calls) {
  const make = (adapterId, models) => ({
    adapterId,
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend: () => cataloguedBackend(calls, adapterId, models),
  });
  // "aaa" sorts first: it is the environment an unscoped read picks today, and
  // the one that does NOT serve these models.
  const adapters = [make('aaacli', []), make('hermes', HERMES_MODELS)];
  return {
    get(id) {
      const found = adapters.find((adapter) => adapter.adapterId === id);
      if (!found) throw new Error(`unknown CLI adapter "${id}"`);
      return found;
    },
    list() { return adapters; },
  };
}

async function environmentFile(gateHome, id, adapterId) {
  await writeFile(join(gateHome, 'config', 'environments', `${id}.json`), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id, label: id,
    adapterId, executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');
}

/** A provider vendor the Gate answers itself, so "the Gate owns it" is observable. */
async function startStubUpstream(upstreamCalls) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamCalls.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'vendor reply' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

async function makeGate({ provider } = {}) {
  const calls = [];
  const upstreamCalls = [];
  const root = await mkdtemp(join(tmpdir(), 'gate-modelroute-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await environmentFile(gateHome, 'aaa-local', 'aaacli');
  await environmentFile(gateHome, 'hermes-local', 'hermes');

  const upstream = await startStubUpstream(upstreamCalls);
  if (provider) {
    process.env.TEST_KEY = 'fake-key-for-tests';
    await writeFile(join(root, 'registry', `${provider.id}.json`), JSON.stringify({
      kind: 'provider',
      label: provider.id,
      config: {
        flavor: 'openai',
        baseUrl: upstream.baseUrl,
        apiKeyEnv: 'TEST_KEY',
        models: provider.models ?? [],
        streaming: true,
      },
    }), 'utf8');
  }

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registryFor(calls),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
  return { gate, calls, upstreamCalls, upstream };
}

const auth = (gate) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` });
const base = (gate) => `http://127.0.0.1:${gate.port}`;

function chat(gate, body) {
  return fetch(`${base(gate)}/v1/chat/completions`, {
    method: 'POST',
    headers: auth(gate),
    body: JSON.stringify(body),
  });
}

test('a scope-less turn for a model only an environment serves runs in that environment', async () => {
  const { gate, calls, upstream } = await makeGate();
  try {
    const response = await chat(gate, {
      model: 'kilo/kilo-auto/free',
      providerId: 'kilo',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /answered by hermes/);
    assert.ok(calls.includes('hermes:sendMessage:kilo-auto/free'), 'the environment served the turn');
    assert.ok(!calls.some((call) => call.endsWith(':sendMessage:kilo-auto/free') && call.startsWith('aaa')), 'not the environment that does not list the model');
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('an unqualified model is matched against the provider the turn named', async () => {
  const { gate, calls, upstream } = await makeGate();
  try {
    const response = await chat(gate, {
      model: 'deepseek-v4.1-flash',
      providerId: 'opencode-go-session',
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'answered by hermes');
    assert.ok(calls.includes('hermes:sendMessage:deepseek-v4.1-flash'));
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('two quick turns read the environment catalogue once', async () => {
  const { gate, calls, upstream } = await makeGate();
  try {
    for (const turn of [1, 2]) {
      const response = await chat(gate, {
        model: 'kilo/kilo-auto/free',
        providerId: 'kilo',
        messages: [{ role: 'user', content: `turn ${turn}` }],
      });
      assert.equal(response.status, 200);
      await response.json();
    }

    // A burst of turns must not re-read /api/model/options per turn. The
    // catalogues are read together, so the order they land in is not asserted —
    // only that each environment was read once for the whole burst.
    for (const adapter of ['aaacli', 'hermes']) {
      assert.equal(calls.filter((call) => call === `${adapter}:listModels`).length, 1);
    }
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('a model no provider and no environment declares is refused with what to do about it', async () => {
  const { gate, calls, upstream } = await makeGate();
  try {
    const response = await chat(gate, {
      model: 'kilo/ghost-model',
      providerId: 'kilo',
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'unknown_provider');
    assert.equal(
      body.error.message,
      'Model "kilo/ghost-model" is not on this Gate\'s providers or any of its environments. Pick another model.',
    );
    assert.ok(!calls.some((call) => call.includes('sendMessage')));
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('a providerId the Gate owns is never rerouted to an environment', async () => {
  // `opencode-go` is a Gate provider record AND a string an environment might
  // list. The Gate owns it, so the vendor answers — guessing at the other
  // meaning here is exactly the ambiguity the app's scope fixes instead.
  const { gate, calls, upstreamCalls, upstream } = await makeGate({
    provider: { id: 'opencode-go', models: ['deepseek-v4.1-flash'] },
  });
  try {
    const response = await chat(gate, {
      model: 'opencode-go/deepseek-v4.1-flash',
      providerId: 'opencode-go',
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'vendor reply');
    assert.equal(upstreamCalls.length, 1);
    // No catalogue read at all: an owned provider never asks the environments.
    assert.ok(!calls.some((call) => call.endsWith(':listModels')));
    assert.ok(!calls.some((call) => call.includes('sendMessage')));
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('a scope-less turn naming no provider is still refused as unscoped', async () => {
  const { gate, calls, upstream } = await makeGate();
  try {
    const response = await chat(gate, { messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'scope_required');
    // Nothing was routed: there was no provider to qualify a model with.
    assert.ok(!calls.some((call) => call.endsWith(':listModels')));
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('a qualified model id is the one an environment files it under', () => {
  assert.equal(qualifiedModelId('kilo/kilo-auto/free', 'kilo'), 'kilo/kilo-auto/free');
  assert.equal(qualifiedModelId('kilo-auto/free', 'kilo'), 'kilo/kilo-auto/free');
  assert.equal(qualifiedModelId('', 'kilo'), undefined);
  assert.equal(qualifiedModelId('kilo-auto/free', undefined), 'kilo-auto/free');
});

test('an available row beats an unavailable one, Hermes beats the rest', () => {
  const row = (available) => [{ id: 'kilo/kilo-auto/free', available }];
  // Both list it: the signed-in provider answers, the unsigned one cannot.
  assert.equal(
    pickBackendForModel(
      [{ id: 'aaa-local', adapterId: 'aaacli' }, { id: 'hermes-local', adapterId: 'hermes' }],
      new Map([['aaa-local', row(true)], ['hermes-local', row(false)]]),
      'kilo/kilo-auto/free',
    ),
    'aaa-local',
  );
  // Both unavailable: the environment that owns Bots, which is where a provider
  // string like `kilo` belongs, wins over a vendor that does not.
  assert.equal(
    pickBackendForModel(
      [{ id: 'aaa-local', adapterId: 'aaacli' }, { id: 'hermes-local', adapterId: 'hermes' }],
      new Map([['aaa-local', row(false)], ['hermes-local', row(false)]]),
      'kilo/kilo-auto/free',
    ),
    'hermes-local',
  );
  // Nothing lists it, so nothing serves it.
  assert.equal(
    pickBackendForModel([{ id: 'aaa-local' }], new Map([['aaa-local', row(true)]]), 'other/model'),
    null,
  );
});

test('a catalogue read that hangs is not served, and is not asked again', async () => {
  let reads = 0;
  const router = createBackendModelRouter({
    listBackends: async () => [{ id: 'hermes-local', adapterId: 'hermes' }],
    listModels: () => {
      reads += 1;
      return new Promise(() => {});
    },
    readTimeoutMs: 20,
  });

  assert.equal(await router.backendFor('kilo/kilo-auto/free', 'kilo'), null);
  assert.equal(reads, 1);
  // A second turn inside the window reuses the answer instead of parking on the
  // same hanging read.
  assert.equal(await router.backendFor('kilo/kilo-auto/free', 'kilo'), null);
  assert.equal(reads, 1);
});

test('a catalogue read that refuses is not served either', async () => {
  let reads = 0;
  const router = createBackendModelRouter({
    listBackends: async () => [{ id: 'hermes-local', adapterId: 'hermes' }],
    listModels: () => {
      reads += 1;
      return Promise.reject(new Error('hermes: will not start'));
    },
  });

  assert.equal(await router.backendFor('kilo/kilo-auto/free', 'kilo'), null);
  assert.equal(reads, 1);
  assert.equal(CATALOGUE_READ_TIMEOUT_MS, 5_000);
});
