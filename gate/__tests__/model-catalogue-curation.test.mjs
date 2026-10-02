import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

// 2026-10-01, live host: `GET /v1/models?backendId=hermes-local` answered 759
// rows from 13 providers, 172 KB, 2.7-3.9 s EVERY time — `/api/model/options`
// alone costs 3.9 s. The operator asked for a catalogue of what can actually
// run: signed-in providers only, the configured provider instead of the
// built-in it shadows, no image models, and nothing that keeps refusing — all
// of it served from a cache.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

const SESSION = {
  id: 'ses_1', source: 'api_server', user_id: null, model: null, title: 'Session',
  started_at: 1, ended_at: null, end_reason: null, message_count: 0, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  reasoning_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, api_call_count: 0,
  parent_session_id: null, last_active: 1, preview: null, has_system_prompt: false,
  has_model_config: false,
};

/** The live host's catalogue, reduced to the rows every rule acts on. */
function hermesRows() {
  return [
    {
      id: 'kilo/kilo-auto/free', providerId: 'kilo', modelId: 'kilo-auto/free',
      provider: 'KiloCode', label: 'KiloCode · kilo-auto/free', available: true,
      providerSource: 'user-config', providerUserDefined: true,
      providerAliases: ['custom:kilo', 'custom:kilocode', 'kilo', 'kilocode'], providerCurrent: true,
    },
    {
      id: 'kilocode/kilo-auto/free', providerId: 'kilocode', modelId: 'kilo-auto/free',
      provider: 'KiloCode (built-in)', label: 'KiloCode (built-in) · kilo-auto/free', available: true,
      providerSource: 'built-in', providerUserDefined: false, providerAliases: [], providerCurrent: false,
    },
    {
      id: 'opencode-go-session/deepseek-v4.1-flash', providerId: 'opencode-go-session',
      modelId: 'deepseek-v4.1-flash', provider: 'OpenCode Go session header',
      label: 'OpenCode Go session header · deepseek-v4.1-flash', available: true,
      providerSource: 'user-config', providerUserDefined: true, providerAliases: [], providerCurrent: true,
    },
    {
      id: 'opencode-go/omen-alpha', providerId: 'opencode-go', modelId: 'omen-alpha',
      provider: 'OpenCode Go', label: 'OpenCode Go · omen-alpha', available: true,
      providerSource: 'built-in', providerUserDefined: false, providerAliases: [], providerCurrent: false,
    },
    {
      id: 'kilo/google/gemini-3.1-flash-image', providerId: 'kilo', modelId: 'google/gemini-3.1-flash-image',
      provider: 'KiloCode', label: 'KiloCode · google/gemini-3.1-flash-image', available: true,
      providerSource: 'user-config', providerUserDefined: true,
      providerAliases: ['custom:kilocode'], providerCurrent: false,
    },
    {
      id: 'nous/poolside/laguna-xs-2.1:free', providerId: 'nous', modelId: 'poolside/laguna-xs-2.1:free',
      provider: 'Nous Portal', label: 'Nous Portal · poolside/laguna-xs-2.1:free', available: false,
      providerSource: 'built-in', providerUserDefined: false, providerAliases: [], providerCurrent: false,
    },
  ];
}

/**
 * A Hermes environment whose catalogue is a fixed read and whose turns the test
 * decides: `replies[modelId]` is the whole assistant text, `'park'` never
 * answers (so the test can cancel it) and a thrown value is a refusal.
 */
function hermesRegistry(calls, replies = {}, { catalogue } = {}) {
  const adapter = {
    adapterId: 'hermes',
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend() {
      return {
        async listSessions() { return [SESSION]; },
        async createSession(input) {
          return { ...SESSION, id: `ses_${input?.model?.modelId ?? 'bare'}`, model: input?.model ?? null };
        },
        async deleteSession() {},
        async listMessages() { return []; },
        async sendMessage(id, input) {
          calls.push(`sendMessage:${input?.model?.modelId ?? 'none'}`);
          const configured = replies?.[input?.model?.modelId];
          // A thenable is a backend that answers when the test says so, which
          // is how a turn's outcome lands after the phone is already gone.
          const reply = configured && typeof configured.then === 'function'
            ? await configured
            : configured;
          if (reply instanceof Error) throw reply;
          if (reply === 'park') return new Promise(() => {});
          const text = typeof reply === 'string' ? reply : `answered ${input?.model?.modelId ?? 'on the host default'}`;
          return { text, message: { id: 'm', role: 'assistant', content: [{ type: 'text', text }] } };
        },
        // `catalogue` overrides what `/api/model/options` does, so a test can
        // make the read refuse, throw, or hang without rebuilding the adapter.
        async listModels() {
          calls.push('listModels');
          if (catalogue === 'hang') return new Promise(() => {});
          // The read that never answered, then a healthy environment: the shape
          // the shared-slot bound exists for.
          if (catalogue === 'hang-once') {
            if (calls.filter((call) => call === 'listModels').length === 1) return new Promise(() => {});
            return hermesRows();
          }
          if (catalogue === 'refuse') throw new Error('hermes: /api/model/options refused');
          return hermesRows();
        },
        async abort() {},
        async replyApproval() {},
        async streamEvents() {},
      };
    },
  };
  return {
    get(id) { if (id !== 'hermes') throw new Error(`unknown CLI adapter "${id}"`); return adapter; },
    list() { return [adapter]; },
  };
}

async function makeGate({ calls = [], replies, gateOptions = {}, catalogue, provider } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-catalogue-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  if (provider) {
    // A provider record of the Gate's own, so the aggregate catalogue carries
    // Gate rows beside the environment's.
    process.env.TEST_KEY = 'fake-key-for-tests';
    await writeFile(join(root, 'registry', `${provider.id}.json`), JSON.stringify({
      kind: 'provider',
      label: provider.id,
      config: {
        flavor: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyEnv: 'TEST_KEY',
        models: provider.models ?? [],
        streaming: true,
      },
    }), 'utf8');
  }
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'hermes-local.json'), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id: 'hermes-local', label: 'Hermes',
    adapterId: 'hermes', executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: hermesRegistry(calls, replies, { catalogue }),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
    // The real windows are a minute and half an hour; the tests watch the
    // stale-while-refresh answer fire in milliseconds.
    ...gateOptions,
  });
  return { gate, calls };
}

const auth = (gate) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` });
const base = (gate) => `http://127.0.0.1:${gate.port}`;

async function readCatalogue(gate, query = '') {
  const response = await fetch(`${base(gate)}/v1/models?backendId=hermes-local${query}`, { headers: auth(gate) });
  assert.equal(response.status, 200);
  const body = await response.json();
  return new Map(body.data.map((row) => [row.id, row]));
}

const chat = (gate, body, headers = {}) => fetch(`${base(gate)}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...auth(gate), ...headers },
  body: JSON.stringify(body),
});

const sendTurn = (gate, model) => chat(gate, { model, messages: [{ role: 'user', content: 'hi' }] });

const catalogueReads = (calls) => calls.filter((call) => call === 'listModels').length;

test('the catalogue answers what can run, not what the environment lists', async () => {
  const { gate, calls } = await makeGate();
  try {
    const rows = await readCatalogue(gate);

    // The operator's own provider is offered; the built-in it replaced is not.
    assert.equal(rows.get('kilo/kilo-auto/free').hidden, undefined);
    assert.equal(rows.get('kilocode/kilo-auto/free').hiddenReason, 'Replaced by your KiloCode provider');
    assert.equal(rows.get('kilocode/kilo-auto/free').available, false);
    // `opencode-go-session` is the only provider that sends the session header
    // the built-in now requires, so the built-in is the one that goes.
    assert.equal(rows.get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
    assert.equal(rows.get('opencode-go/omen-alpha').hiddenReason, 'Replaced by your OpenCode Go session header provider');
    // An image model cannot hold a conversation, but nothing about its provider
    // is wrong, so it keeps the availability it had.
    assert.equal(rows.get('kilo/google/gemini-3.1-flash-image').hiddenReason, 'Not a chat model');
    assert.equal(rows.get('kilo/google/gemini-3.1-flash-image').available, true);
    // 42 of the live host's 55 providers are signed out.
    assert.equal(rows.get('nous/poolside/laguna-xs-2.1:free').hiddenReason, 'Not signed in on the host');
    // Every row is tagged with the environment that serves it, and none is
    // dropped: the phone repairs a stale pin by finding its row.
    for (const row of rows.values()) assert.equal(row.backendId, 'hermes-local');
    assert.equal(rows.size, 6);
    assert.equal(catalogueReads(calls), 1);
  } finally {
    await gate.close();
  }
});

test('a second catalogue read inside the window does not ask the environment again', async () => {
  const { gate, calls } = await makeGate();
  try {
    await readCatalogue(gate);
    await readCatalogue(gate);
    await readCatalogue(gate);
    assert.equal(catalogueReads(calls), 1);
  } finally {
    await gate.close();
  }
});

test('a stale copy is answered at once and refreshed once behind the request', async () => {
  const { gate, calls } = await makeGate({ gateOptions: { catalogueTtlMs: 200, catalogueStaleMs: 5_000 } });
  try {
    await readCatalogue(gate);
    assert.equal(catalogueReads(calls), 1);

    await sleep(300);
    const started = Date.now();
    const rows = await readCatalogue(gate);
    const answeredIn = Date.now() - started;

    // The answer came from the copy, not from a 3.9 s `/api/model/options`.
    assert.equal(rows.size, 6);
    assert.ok(answeredIn < 500, `answered in ${answeredIn}ms`);
    // ...and exactly one refresh ran behind it, however many readers arrive.
    // The wait is shorter than the TTL above so the freshly refreshed copy is
    // still within its fresh window when the next read arrives.
    await sleep(50);
    assert.equal(catalogueReads(calls), 2);
    await readCatalogue(gate);
    assert.equal(catalogueReads(calls), 2, 'the refreshed copy is fresh again');
  } finally {
    await gate.close();
  }
});

test('`?refresh=1` is a live read, not a cached one', async () => {
  const { gate, calls } = await makeGate();
  try {
    await readCatalogue(gate);
    await readCatalogue(gate, '&refresh=1');
    assert.equal(catalogueReads(calls), 2);
    // The live read became the copy the next ordinary read is answered from.
    await readCatalogue(gate);
    assert.equal(catalogueReads(calls), 2);
  } finally {
    await gate.close();
  }
});

test('a model that refuses its last two turns is hidden, and an answer brings it back', async () => {
  // The operator's screenshot: `opencode-go/deepseek-v4.1-flash ... refused it
  // (400)`. A model like that stayed in the picker forever, because nothing
  // anywhere kept score.
  const refusal = 'HTTP 400: MissingSessionID';
  const { gate } = await makeGate({ replies: { 'deepseek-v4.1-flash': refusal } });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await sendTurn(gate, 'opencode-go-session/deepseek-v4.1-flash');
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, 'upstream_error');
    }

    const rows = await readCatalogue(gate);
    const failed = rows.get('opencode-go-session/deepseek-v4.1-flash');
    assert.equal(failed.hidden, true);
    assert.equal(failed.available, false);
    assert.match(failed.hiddenReason, /^Failed its last 2 turns \(HTTP 400: MissingSessionID\) - hidden until .+ UTC$/);
    // Nothing else was condemned by it.
    assert.equal(rows.get('kilo/kilo-auto/free').hidden, undefined);
    assert.equal(
      rows.get('opencode-go/omen-alpha').hiddenReason,
      'Replaced by your OpenCode Go session header provider',
    );
  } finally {
    await gate.close();
  }
});

test('one answer clears a failing verdict, without the catalogue being re-read', async () => {
  const replies = { 'deepseek-v4.1-flash': 'HTTP 400: MissingSessionID' };
  const { gate, calls } = await makeGate({ replies });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await (await sendTurn(gate, 'opencode-go-session/deepseek-v4.1-flash')).json();
    }
    assert.equal((await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hidden, true);
    const reads = catalogueReads(calls);

    // The operator fixed whatever it was, and the model answers. Health is
    // applied on every response, so the verdict drops without the environment
    // being asked anything.
    replies['deepseek-v4.1-flash'] = 'answered at last';
    const answered = await sendTurn(gate, 'opencode-go-session/deepseek-v4.1-flash');
    assert.equal((await answered.json()).choices[0].message.content, 'answered at last');

    const rows = await readCatalogue(gate);
    assert.equal(rows.get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
    assert.equal(catalogueReads(calls), reads);
  } finally {
    await gate.close();
  }
});

test('a turn the operator cancelled records nothing about the model', async () => {
  // Stop is the caller's decision and says nothing about the model, so two
  // cancelled turns must not earn it a hiding.
  const { gate, calls } = await makeGate({ replies: { 'deepseek-v4.1-flash': 'park' } });
  const sent = () => calls.filter((call) => call === 'sendMessage:deepseek-v4.1-flash').length;
  try {
    for (const turnId of ['stop-me-0001', 'stop-me-0002']) {
      const before = sent();
      const pending = chat(gate, {
        model: 'opencode-go-session/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }, { 'X-Versutus-Turn-Id': turnId });
      // Stop only means something once the turn is really in flight.
      await waitFor(() => sent() > before);
      const cancel = await fetch(`${base(gate)}/v1/chat/cancel`, {
        method: 'POST',
        headers: auth(gate),
        body: JSON.stringify({ turnId }),
      });
      assert.equal((await cancel.json()).cancelled, true, 'the turn was found to stop');
      await pending.then((response) => response.text());
    }

    assert.equal((await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
  } finally {
    await gate.close();
  }
});

test('a phone that walks away mid-turn records nothing about the model', async () => {
  // The other half of the cancel rule, and the harder half: a NAMED turn whose
  // phone disconnects is detached, not stopped, so it runs to its own
  // conclusion. What the backend then said is real, but it was never read by
  // anybody — it is not something the operator asked about, and it must not
  // quietly clear a verdict earned by two turns they did see.
  const replies = { 'deepseek-v4.1-flash': 'HTTP 400: MissingSessionID' };
  const { gate, calls } = await makeGate({ replies });
  const sent = () => calls.filter((call) => call === 'sendMessage:deepseek-v4.1-flash').length;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) await (await sendTurn(gate, 'opencode-go-session/deepseek-v4.1-flash')).json();
    assert.equal((await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hidden, true);

    // The model is working again — into a phone that had already hung up.
    let answer;
    replies['deepseek-v4.1-flash'] = new Promise((resolve) => { answer = resolve; });
    const before = sent();
    const hangUp = new AbortController();
    const walking = fetch(`${base(gate)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...auth(gate), 'Content-Type': 'application/json', 'X-Versutus-Turn-Id': 'walk-away-0001',
      },
      body: JSON.stringify({
        model: 'opencode-go-session/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
      signal: hangUp.signal,
    }).then((response) => response.text()).catch(() => null);
    await waitFor(() => sent() > before);
    hangUp.abort();
    await walking;
    await sleep(100);
    answer('answered at last');
    await sleep(150);

    assert.equal((await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hidden, true);
  } finally {
    await gate.close();
  }
});

test('a turn that completes with no assistant content is a failure too', async () => {
  // The exact shape of `opencode-go` on the live host: accepted, finished, and
  // with nothing to show for it.
  const { gate } = await makeGate({ replies: { 'deepseek-v4.1-flash': '' } });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await sendTurn(gate, 'opencode-go-session/deepseek-v4.1-flash');
      assert.equal((await response.json()).error.code, 'empty_turn');
    }
    const rows = await readCatalogue(gate);
    const failed = rows.get('opencode-go-session/deepseek-v4.1-flash');
    assert.equal(failed.hidden, true);
    assert.match(failed.hiddenReason, /^Failed its last 2 turns \(/);
    assert.equal(rows.get('kilo/kilo-auto/free').hidden, undefined);
  } finally {
    await gate.close();
  }
});

test('a backend that refuses the turn outright is a failure too', async () => {
  const { gate } = await makeGate({ replies: { 'deepseek-v4.1-flash': new Error('hermes: HTTP 429: rate limit reached for this model') } });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await sendTurn(gate, 'opencode-go-session/deepseek-v4.1-flash');
      assert.equal((await response.json()).error.code, 'backend_error');
    }
    assert.match(
      (await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hiddenReason,
      /^Failed its last 2 turns \(hermes: HTTP 429: rate limit reached for this model\)/,
    );
  } finally {
    await gate.close();
  }
});

test('a Gate-side fault that fails two turns hides nothing', async () => {
  // The 2026-10-02 incident: `call()` read OpenCode's empty 204 with
  // `response.json()`, every turn answered `Unexpected end of JSON input`, and
  // the model-health table hid the operator's models for six hours on the
  // strength of a defect in the Gate's own code. A throw the Gate caused is not
  // evidence about a model, so it records nothing at all — not a failure, and not
  // a success either (which would have cleared a verdict the model really earned).
  const { gate } = await makeGate({ replies: { 'deepseek-v4.1-flash': new SyntaxError('Unexpected end of JSON input') } });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await sendTurn(gate, 'opencode-go-session/deepseek-v4.1-flash');
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.message, 'Unexpected end of JSON input');
    }
    assert.equal((await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
  } finally {
    await gate.close();
  }
});

test('a STREAMED turn that throws is a failure too, and an answer clears it', async () => {
  // The app always streams (`manifest-client` sends `stream: true`), so this is
  // the path that actually runs. A thrown backend turn — Hermes non-2xx, 429,
  // 5xx, a stall — lands in streamBackendTurn's catch, and before this was
  // recorded there it earned no verdict at all: the model that refuses every
  // streamed turn stayed in the picker forever.
  const failure = Object.assign(new Error('hermes: 502 upstream is unavailable'), { code: 'backend_error' });
  const replies = { 'deepseek-v4.1-flash': failure };
  const { gate } = await makeGate({ replies });
  const streamTurn = () => chat(gate, {
    model: 'opencode-go-session/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  }).then((response) => response.text());

  try {
    assert.match(await streamTurn(), /hermes: 502 upstream is unavailable/);
    assert.match(await streamTurn(), /hermes: 502 upstream is unavailable/);
    const failed = (await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash');
    assert.equal(failed.hidden, true);
    assert.equal(failed.available, false);
    assert.match(failed.hiddenReason, /^Failed its last 2 turns \(hermes: 502 upstream is unavailable\)/);

    // And the model answering again clears it, on the streamed path too.
    replies['deepseek-v4.1-flash'] = 'answered at last';
    assert.match(await streamTurn(), /answered at last/);
    assert.equal((await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
  } finally {
    await gate.close();
  }
});

test('a STREAMED turn that fails on the Gate\'s own fault records nothing at all', async () => {
  // The same rule on the path the app always takes, and with something to get
  // wrong in both directions: a verdict the model really earned must survive the
  // Gate's own defects (recording a success here would clear it, and a Gate-side
  // failure must never be counted against the model either).
  const refusal = new Error('HTTP 400: MissingSessionID');
  const replies = { 'deepseek-v4.1-flash': refusal };
  const { gate } = await makeGate({ replies });
  const streamTurn = () => chat(gate, {
    model: 'opencode-go-session/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  }).then((response) => response.text());

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) await streamTurn();
    assert.match(
      (await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hiddenReason,
      /^Failed its last 2 turns \(HTTP 400: MissingSessionID\)/,
    );

    // Two turns that failed on a bug in the Gate: the model's own record is
    // untouched — neither a third failure nor a clear.
    replies['deepseek-v4.1-flash'] = new SyntaxError('Unexpected end of JSON input');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.match(await streamTurn(), /Unexpected end of JSON input/);
    }
    const rows = await readCatalogue(gate);
    assert.equal(rows.get('opencode-go-session/deepseek-v4.1-flash').hidden, true);
    assert.match(rows.get('opencode-go-session/deepseek-v4.1-flash').hiddenReason, /last 2 turns \(HTTP 400/);
  } finally {
    await gate.close();
  }
});

test('a streamed refusal delivered as normal text is a failure too', async () => {
  // Hermes returns a refused turn as a completion whose whole text is the
  // error, and a streamed turn relays that text to the phone. It is the
  // operator's refusal, not the model's answer.
  const replies = { 'deepseek-v4.1-flash': 'HTTP 400: MissingSessionID' };
  const { gate } = await makeGate({ replies });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await chat(gate, {
        model: 'opencode-go-session/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }).then((response) => response.text());
    }
    assert.match(
      (await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hiddenReason,
      /^Failed its last 2 turns \(HTTP 400: MissingSessionID\)/,
    );
  } finally {
    await gate.close();
  }
});

test('a streamed turn that completes with no content is a failure too', async () => {
  const { gate } = await makeGate({ replies: { 'deepseek-v4.1-flash': '' } });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await chat(gate, {
        model: 'opencode-go-session/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const text = await response.text();
      assert.match(text, /empty_turn/);
    }
    assert.equal((await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hidden, true);
  } finally {
    await gate.close();
  }
});

test('a streamed turn the operator cancelled records nothing', async () => {
  // The guards that keep a caller's own stop out of the verdict have to hold on
  // the streamed path too — it is the path the app uses.
  const { gate, calls } = await makeGate({ replies: { 'deepseek-v4.1-flash': 'park' } });
  const sent = () => calls.filter((call) => call === 'sendMessage:deepseek-v4.1-flash').length;
  try {
    for (const turnId of ['stop-stream-01', 'stop-stream-02']) {
      const before = sent();
      const pending = chat(gate, {
        model: 'opencode-go-session/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }, { 'X-Versutus-Turn-Id': turnId });
      await waitFor(() => sent() > before);
      const cancel = await fetch(`${base(gate)}/v1/chat/cancel`, {
        method: 'POST',
        headers: auth(gate),
        body: JSON.stringify({ turnId }),
      });
      assert.equal((await cancel.json()).cancelled, true);
      await pending.then((response) => response.text());
    }
    assert.equal((await readCatalogue(gate)).get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
  } finally {
    await gate.close();
  }
});

test('the aggregate catalogue merges nothing across the Gate and an environment', async () => {
  // `/v1/models` without a backendId answers every provider the Gate owns
  // beside every environment's rows. `opencode-go` is a provider id the Gate can
  // legitimately own AND a Hermes built-in, and Hermes's configured
  // `opencode-go-session` merges the Hermes twin only. Hiding the Gate's rows
  // would take away a model the vendor behind it can still answer.
  const { gate } = await makeGate({
    provider: { id: 'opencode-go', models: ['deepseek-v4.1-flash'] },
  });
  try {
    const response = await fetch(`${base(gate)}/v1/models`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const rows = new Map((await response.json()).data.map((row) => [row.id, row]));

    const gateRow = rows.get('deepseek-v4.1-flash');
    assert.equal(gateRow.provider, 'opencode-go');
    assert.equal(gateRow.backendId, undefined);
    assert.equal(gateRow.hidden, undefined);
    // Only the environment's built-in is condemned.
    assert.equal(
      rows.get('opencode-go/omen-alpha').hiddenReason,
      'Replaced by your OpenCode Go session header provider',
    );
    assert.equal(rows.get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
  } finally {
    await gate.close();
  }
});

test('a catalogue read that fails is an error, not an empty picker', async () => {
  // Hermes's `/api/model/options` costs 3.9 s on the live host. A read that
  // failed or overran its bound used to be remembered as "this environment
  // serves nothing", which blanked the picker for a minute with no error
  // anywhere — the operator could not tell a slow read from an empty catalogue.
  const { gate, calls } = await makeGate({ catalogue: 'refuse' });
  try {
    for (let read = 0; read < 2; read += 1) {
      const response = await fetch(`${base(gate)}/v1/models?backendId=hermes-local`, { headers: auth(gate) });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, 'backend_error');
    }
    // Nothing was cached as an answer, so the next read tries again rather than
    // repeating the blank for the rest of the window.
    assert.equal(catalogueReads(calls), 2);
  } finally {
    await gate.close();
  }
});

test('the aggregate catalogue omits an environment that cannot be read', async () => {
  // The aggregate branch's own try/catch per environment, restored: the Gate's
  // own providers still answer, and the environment contributes nothing.
  const { gate } = await makeGate({
    catalogue: 'refuse',
    provider: { id: 'openai', models: ['gpt-5.6-sol'] },
  });
  try {
    const response = await fetch(`${base(gate)}/v1/models`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const ids = (await response.json()).data.map((row) => row.id);
    assert.ok(ids.includes('gpt-5.6-sol'), 'the Gate providers are still offered');
    assert.ok(!ids.some((id) => id.startsWith('kilo/')), 'the unreadable environment contributes no rows');
  } finally {
    await gate.close();
  }
});

test('a slow catalogue read is waited for, not answered as empty', async () => {
  // The bound that matters is the one the live host measured: 3.9 s for one
  // `/api/model/options`. A read that overruns the routing lookup's 5 s bound
  // must not cost the picker its rows.
  const { gate } = await makeGate({
    gateOptions: { catalogueResponseTimeoutMs: 50 },
    catalogue: 'hang',
  });
  try {
    const started = Date.now();
    const response = await fetch(`${base(gate)}/v1/models?backendId=hermes-local`, { headers: auth(gate) });
    assert.equal(response.status, 502);
    // Waited for its own generous bound, not answered instantly.
    assert.ok(Date.now() - started >= 50, 'the read was given its bound');
  } finally {
    await gate.close();
  }
});

test('a catalogue read that never answers does not poison the next request', async () => {
  // The single-flight slot is shared by every reader of an environment, and it
  // used to be released only when the read SETTLED. One `/api/model/options`
  // that never answers therefore held it for the life of the process: every
  // later request joined that read and 502'd, even after the environment
  // recovered and would have answered the next read.
  const { gate, calls } = await makeGate({
    gateOptions: { catalogueResponseTimeoutMs: 50 },
    catalogue: 'hang-once',
  });
  try {
    const first = await fetch(`${base(gate)}/v1/models?backendId=hermes-local`, { headers: auth(gate) });
    assert.equal(first.status, 502);
    assert.equal((await first.json()).error.code, 'backend_error');

    // The environment is healthy again. The bound released the slot, so this
    // is a fresh read rather than a join on the one that never answered.
    const rows = await readCatalogue(gate);
    assert.equal(rows.size, 6);
    assert.equal(catalogueReads(calls), 2);
  } finally {
    await gate.close();
  }
});

test('concurrent cold catalogue reads share one live read', async () => {
  // Every picker open on every device arriving at once must not queue up one
  // 3.9 s `/api/model/options` each.
  const { gate, calls } = await makeGate();
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${base(gate)}/v1/models?backendId=hermes-local`, { headers: auth(gate) })),
    );
    for (const response of responses) assert.equal(response.status, 200);
    await Promise.all(responses.map((response) => response.json()));
    assert.equal(catalogueReads(calls), 1);
  } finally {
    await gate.close();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `read` is true, or give up. */
async function waitFor(read, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await read()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the turn to be in flight');
    await sleep(10);
  }
}