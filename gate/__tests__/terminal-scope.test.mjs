import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';

// The shell is the one route that runs a process on the host, so a device
// grant's recorded scopes have to decide it. `/v1/terminal/stream` used to
// answer any valid token — a device paired with `['chat:send']` was issued no
// `terminal:use` and still got a shell, so the scope list looked like access
// control but was never consulted. What a grant carries is the whole grant:
// an empty list is a grant of nothing. The Gate's own token (no device grant)
// stays the operator's unrestricted credential.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A terminal manager with no real shell behind it. */
function fakeTerminal() {
  const opened = [];
  const sessions = new Map();
  return {
    opened,
    open(handlers) {
      const session = {
        sid: `sid-${opened.length + 1}`,
        owner: handlers.owner ?? null,
        written: [],
        closed: false,
        write(data) { session.written.push(data); },
        close() { session.closed = true; sessions.delete(session.sid); },
        handlers,
      };
      opened.push(session);
      sessions.set(session.sid, session);
      return session;
    },
    get(sid) { return sessions.get(sid) ?? null; },
    closeAll() { for (const s of [...sessions.values()]) s.close(); },
  };
}

/**
 * A real Gate whose device-token store already holds one grant per named
 * device, issued with exactly the scopes passed here — the same store
 * `cli.mjs pair approve` writes.
 */
async function makeGate(scopesByDevice) {
  const root = await mkdtemp(join(tmpdir(), 'gate-terminal-scope-'));
  roots.push(root);
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(join(root, 'registry', 'test-provider.json'), JSON.stringify({
    kind: 'provider',
    label: 'Test Provider',
    config: { flavor: 'openai', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'TEST_KEY', models: ['test-model-1'] },
  }), 'utf8');

  const store = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const tokens = {};
  for (const [deviceId, scopes] of Object.entries(scopesByDevice)) {
    tokens[deviceId] = await store.issue(deviceId, { role: 'operator', scopes });
  }

  const terminal = fakeTerminal();
  const gate = await createGate({ root, port: 0, terminalSessions: terminal });
  return { gate, tokens, terminal };
}

function openShell(gate, token) {
  return fetch(`http://127.0.0.1:${gate.port}/v1/terminal/stream`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

test('a device grant without terminal:use is refused the shell', async () => {
  const { gate, tokens, terminal } = await makeGate({ 'phone-limited': ['chat:send', 'chat:read'] });
  try {
    const response = await openShell(gate, tokens['phone-limited']);
    try {
      assert.equal(response.status, 403, 'a grant without terminal:use must not open a shell');
      const body = await response.json();
      assert.equal(body.error.code, 'scope_required');
      assert.match(body.error.message, /terminal:use/);
    } finally {
      if (!response.bodyUsed) await response.body?.cancel?.().catch(() => undefined);
    }
    assert.equal(terminal.opened.length, 0, 'no shell may spawn for the refused grant');
  } finally {
    await gate.close();
  }
});

test('a grant issued with no scopes at all is a grant of nothing', async () => {
  const { gate, tokens, terminal } = await makeGate({ 'phone-scopeless': [] });
  try {
    const response = await openShell(gate, tokens['phone-scopeless']);
    try {
      assert.equal(response.status, 403, 'an empty scope list must not be read as full access');
    } finally {
      if (!response.bodyUsed) await response.body?.cancel?.().catch(() => undefined);
    }
    assert.equal(terminal.opened.length, 0, 'no shell may spawn for the refused grant');
  } finally {
    await gate.close();
  }
});

test('a device grant with terminal:use still opens a shell', async () => {
  const { gate, tokens, terminal } = await makeGate({ 'phone-full': ['chat:send', 'terminal:use'] });
  try {
    const response = await openShell(gate, tokens['phone-full']);
    try {
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      // Headers flush with the session frame, which the route writes after it
      // has opened the shell: one session is the proof the route ran to the end.
      assert.equal(terminal.opened.length, 1, 'the grant with terminal:use opens the shell');
    } finally {
      if (!response.bodyUsed) await response.body?.cancel?.().catch(() => undefined);
    }
  } finally {
    await gate.close();
  }
});

test('the Gate\'s own token is not a device grant and keeps the shell', async () => {
  const { gate, terminal } = await makeGate({});
  try {
    const response = await openShell(gate, gate.token);
    try {
      assert.equal(response.status, 200);
      assert.equal(terminal.opened.length, 1, 'the operator token keeps its unrestricted shell');
    } finally {
      if (!response.bodyUsed) await response.body?.cancel?.().catch(() => undefined);
    }
  } finally {
    await gate.close();
  }
});
