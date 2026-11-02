import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

// Node holds a timer's delay in a signed 32-bit integer: a larger delay is
// replaced with 1 ms. The detached-turn ceiling can be overridden from the
// environment (VERSUTUS_GATE_DETACHED_TURN_MAX_MS) or injected directly, so an
// oversized value used to end every detached turn the instant the phone left —
// the exact opposite of the safety ceiling it was meant to be. These drive a
// real Gate, because the claim is about the timer that is actually armed.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

// The waits below are real I/O around a real socket, so they keep the real
// timer even when a test elsewhere in the suite walks a mock clock.
const realSetTimeout = globalThis.setTimeout;

afterEach(async () => {
  await Promise.all([...new Set(roots.splice(0))].map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

const SESSION = {
  id: 'ses_1',
  source: 'stubcli',
  user_id: null,
  model: null,
  title: 'Stub session',
  started_at: 1,
  ended_at: null,
  end_reason: null,
  message_count: 0,
  tool_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  estimated_cost_usd: null,
  actual_cost_usd: null,
  api_call_count: 0,
  parent_session_id: null,
  last_active: 1,
  preview: null,
  has_system_prompt: false,
  has_model_config: false,
};

/**
 * An adapter whose turn behaviour the test controls: every `sendMessage` parks
 * until the test resolves it, recording the abort signal so "was this turn
 * ended?" is observable.
 */
function stubTurnRegistry(turns) {
  // The runner subscribes and then sends with no await in between, so the feed
  // signal and the send of one turn are adjacent and a queue pairs them up.
  const signals = [];
  const adapter = {
    adapterId: 'stubcli',
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend() {
      return {
        async listSessions() { return [SESSION]; },
        async createSession(input) { return { ...SESSION, title: input?.title ?? null }; },
        async deleteSession() {},
        async listMessages() { return []; },
        async sendMessage(id, input) {
          return new Promise((resolve) => {
            turns.push({ resolve, signal: signals.shift(), text: input?.text });
          });
        },
        async listModels() { return []; },
        async abort() {},
        async replyApproval() {},
        async streamEvents(id, onEvent, signal) {
          signals.push(signal);
          return new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', resolve, { once: true });
          });
        },
      };
    },
  };
  return {
    get(id) { if (id !== 'stubcli') throw new Error(`unknown CLI adapter "${id}"`); return adapter; },
    list() { return [adapter]; },
  };
}

async function makeGate({ turns = [], registry, gateOptions } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-ceiling-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'stub-local.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'cli-environment',
    id: 'stub-local',
    label: 'Stub stubcli',
    adapterId: 'stubcli',
    executable: { path: 'C:\\stub.exe' },
    protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' },
    providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registry ?? stubTurnRegistry(turns),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
    ...(gateOptions ?? {}),
  });
  let closed = false;
  return {
    gate,
    turns,
    base: `http://127.0.0.1:${gate.port}`,
    close: () => (closed ? Promise.resolve() : (closed = true, gate.close())),
  };
}

function auth(gate) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
}

const TURN_ID = 'turn-ceiling-01';

const streamingTurn = (gate, { turnId, controller } = {}) => fetch(
  `http://127.0.0.1:${gate.port}/v1/chat/completions`,
  {
    method: 'POST',
    headers: {
      ...auth(gate),
      ...(turnId ? { 'X-Versutus-Turn-Id': turnId } : {}),
    },
    signal: controller?.signal,
    body: JSON.stringify({
      backendId: 'stub-local',
      sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'say it once' }],
      stream: true,
    }),
  },
);

const turnMeta = async (gate, turnId) => {
  const response = await fetch(`${gate.base}/v1/turns/${turnId}`, {
    headers: { Authorization: `Bearer ${gate.gate.token}` },
  });
  return { status: response.status, body: await response.json() };
};

/** Bounded poll: the seams under test (abort, journal writes) are async. */
const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  return false;
};

/** Detach the phone from a running turn and wait for the Gate to observe it. */
async function detachRunningTurn(gate) {
  const controller = new AbortController();
  const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
  pending.catch(() => undefined);
  assert.ok(await until(() => gate.turns.length === 1), 'the turn reached the backend');
  controller.abort();
  await pending.catch(() => undefined);
  // The close handler is the detach; give it a turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The turn was detached — so a bound did end it — but the short stall watchdog,
 * not the ceiling, is what ended it. The ceiling under test is days away; on the
 * old code Node armed it as 1 ms, so it won and the journal said `max_age`.
 */
async function assertEndedByStall(gate) {
  const interrupted = async () => (await turnMeta(gate, TURN_ID)).body.status === 'interrupted';
  assert.ok(await until(interrupted), 'the detached turn was ended by one of its bounds');
  const { body } = await turnMeta(gate, TURN_ID);
  assert.equal(body.reason, 'stalled', 'an oversized ceiling must not be the bound that fires');
}

test('an environment ceiling too large for a timer leaves the ceiling out of it', async () => {
  const turns = [];
  const previous = process.env.VERSUTUS_GATE_DETACHED_TURN_MAX_MS;
  // About thirty-four years: far beyond what a setTimeout can express, so on
  // the old code Node would arm it as 1 ms.
  process.env.VERSUTUS_GATE_DETACHED_TURN_MAX_MS = String(2 ** 40);
  let gate;
  try {
    gate = await makeGate({ turns, gateOptions: { detachedStallMs: 60 } });
  } finally {
    if (previous === undefined) delete process.env.VERSUTUS_GATE_DETACHED_TURN_MAX_MS;
    else process.env.VERSUTUS_GATE_DETACHED_TURN_MAX_MS = previous;
  }

  try {
    await detachRunningTurn(gate);
    await assertEndedByStall(gate);
  } finally {
    await gate.close();
  }
});

test('an injected ceiling too large for a timer is bounded the same way', async () => {
  const turns = [];
  const gate = await makeGate({
    turns,
    gateOptions: { detachedStallMs: 60, detachedTurnMaxMs: 2 ** 40 },
  });

  try {
    await detachRunningTurn(gate);
    await assertEndedByStall(gate);
  } finally {
    await gate.close();
  }
});

test('a ceiling that fits a timer still ends the detached turn as max_age', async () => {
  const turns = [];
  const gate = await makeGate({
    turns,
    gateOptions: { detachedStallMs: 30_000, detachedTurnMaxMs: 40 },
  });

  try {
    await detachRunningTurn(gate);
    assert.ok(await until(() => turns[0].signal?.aborted === true), 'a turn nobody is watching must not run forever');
    const { body } = await turnMeta(gate, TURN_ID);
    assert.equal(body.status, 'interrupted');
    assert.equal(body.reason, 'max_age');
  } finally {
    await gate.close();
  }
});
