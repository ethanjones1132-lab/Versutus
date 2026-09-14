import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';
import { fakeRunner } from './fixtures/cli-protocols/fake-runner.mjs';

// The notifier's `run` and `approval` arms were written with no caller: the
// only pushNotifier.notify call site was the chat-completion seam, so a run
// settling or asking for approval never reached the tray even for an
// enabled device outside quiet hours. Solution A4 names run completed /
// errored / approval required as the subscription's own trigger classes.
// These tests drive a REAL gate (ephemeral port, real notifier, stubbed
// Expo endpoint) the same way push-notifier-wiring-test.mjs does — a CLI
// environment holds the run, the environments archive path emits the
// events, and the wiring announces them.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function gateStubUpstreamJson(messages) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { data: messages.map((message, index) => ({ status: 'ok', id: `ticket-${index}` })) };
    },
  };
}

function gateStubUpstreamReceipts(ids) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) };
    },
  };
}

async function waitFor(predicate, { ms = 4000, step = 25 } = {}) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

async function contentFor(response) {
  return JSON.stringify(await response.json());
}

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-runpush-'));
  roots.push(root);
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(root, 'config', 'environments'), { recursive: true });
  const gateHome = join(root, '.gate-home');
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });

  const pushFetchCalls = [];
  const pushFetch = async (url, init) => {
    if (String(url).endsWith('/push/send')) {
      pushFetchCalls.push(JSON.parse(init.body));
      return gateStubUpstreamJson(JSON.parse(init.body));
    }
    return gateStubUpstreamReceipts(JSON.parse(init.body).ids);
  };

  const gate = await createGate({ root, port: 0, gateHome, pushFetch });
  return { gate, pushFetchCalls };
}

const auth = (gate) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` });
const base = (gate) => `http://127.0.0.1:${gate.port}`;

async function rpc(gate, method, params) {
  return fetch(`${base(gate)}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: auth(gate),
    body: JSON.stringify({ method, params }),
  });
}

async function pairAndEnable(gate) {
  // Via the paired-device identity path is overkill here; a device token
  // issue is what the app's own flow produces, and push-rpc binds to it the
  // same either way.
  const store = new DeviceTokenStore(join(roots[roots.length - 1], '.device-tokens.json'));
  const bearer = await store.issue('phone-grant', { role: 'operator', scopes: ['operator.read'] });
  const registered = await fetch(`${base(gate)}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { ...auth(gate), Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      method: 'notifications.register',
      params: { expoPushToken: 'ExponentPushToken[phone-row]', platform: 'ios', timezone: 'UTC' },
    }),
  });
  assert.equal(registered.status, 200, await contentFor(registered));
  const enabled = await fetch(`${base(gate)}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { ...auth(gate), Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ method: 'notifications.preferences.set', params: { enabled: true } }),
  });
  assert.equal(enabled.status, 200, await contentFor(enabled));
}

// Register an environment wired to the fakeRunner, which exits 0 on a
// 'status' run (--version probe) — a short, deterministic settle.
async function environmentAndSettledRun(gate) {
  const binary = await fakeRunner('0.142.1');
  const created = await rpc(gate, 'environments.create', validEnvironment({
    id: 'codex-testbed',
    adapterId: 'codex',
    executable: { path: binary },
    workspacePolicy: {
      roots: [roots[roots.length - 1]],
      defaultRoot: roots[roots.length - 1],
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
  }));
  assert.equal(created.status, 200, await contentFor(created));
  const started = await fetch(`${base(gate)}/v1/environments/codex-testbed/runs`, {
    method: 'POST',
    headers: auth(gate),
    body: JSON.stringify({ operation: 'status', sandbox: 'read_only', input: {} }),
  });
  assert.equal(started.status, 200, await contentFor(started));
  const { runId } = await started.json();
  return runId;
}

function pushesOfKind(pushFetchCalls, kind) {
  return pushFetchCalls.flat().filter((message) => message.data?.kind === kind);
}

test('a run that settles announces itself to an enabled device as a run push', async () => {
  const { gate, pushFetchCalls } = await makeGate();
  try {
    await pairAndEnable(gate);
    const runId = await environmentAndSettledRun(gate);

    await waitFor(() => pushesOfKind(pushFetchCalls, 'run').length > 0);
    const [push] = pushesOfKind(pushFetchCalls, 'run');
    assert.equal(push.to, 'ExponentPushToken[phone-row]');
    assert.equal(push.data.runId, runId);
    assert.equal(push.data.state, 'completed');
    assert.equal(push.channelId, 'model-replies');
    assert.equal(push.title, 'Versutus finished a run');
  } finally {
    await gate.close();
  }
});

test('an approval-required run pages the phone before spawning, without a reply push', async () => {
  const { gate, pushFetchCalls } = await makeGate();
  try {
    await pairAndEnable(gate);
    const binary = await fakeRunner('0.142.1');
    const created = await rpc(gate, 'environments.create', validEnvironment({
      id: 'codex-askfirst',
      adapterId: 'codex',
      executable: { path: binary },
      workspacePolicy: {
        roots: [roots[roots.length - 1]],
        defaultRoot: roots[roots.length - 1],
        defaultSandbox: 'workspace_write',
        allowAdditionalRoots: false,
      },
    }));
    assert.equal(created.status, 200, await contentFor(created));
    // A workspace-writing prompt must ask before it spawns. The run holds
    // on its card, so no terminal event fires and nothing may page the
    // phone — the approval push is the only one this run produces.
    const started = await fetch(`${base(gate)}/v1/environments/codex-askfirst/runs`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ operation: 'prompt', sandbox: 'read_only', input: { prompt: 'say hi' } }),
    });
    assert.equal(started.status, 200, await contentFor(started));

    await waitFor(() => pushesOfKind(pushFetchCalls, 'approval').length > 0);
    const [approval] = pushesOfKind(pushFetchCalls, 'approval');
    assert.equal(approval.title, 'Approval required');
    assert.equal(approval.channelId, 'approvals');
    assert.equal(approval.data.runId, (await started.json()).runId);
    assert.equal(typeof approval.data.approvalId, 'string');
    assert.ok(
      /^This task can modify files in its workspace/.test(approval.body ?? ''),
      'the card summary the event carried is the rich body core',
    );
    assert.equal(pushesOfKind(pushFetchCalls, 'run').length, 0, 'nothing settles while the card is open');
  } finally {
    await gate.close();
  }
});

test('a run push names the state that actually happened — cancelled is not finished', async () => {
  const { createPushNotifier } = await import('../core/push-notifier.mjs');
  const tokens = {
    listEnabled: async () => [{
      expoPushToken: 'ExponentPushToken[token-1]', platform: 'ios', timezone: 'UTC',
      enabled: true, richBody: false, botIds: [], quietHours: null,
    }],
    removeByToken: async () => false,
  };
  const sent = [];
  const notifier = createPushNotifier({
    tokens,
    send: async (messages) => { sent.push(...messages); return { ok: true }; },
  });
  await notifier.notify({ trigger: 'run', runId: 'r-1', state: 'cancelled' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Versutus was stopped');
});
