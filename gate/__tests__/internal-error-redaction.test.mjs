import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

// The last line of defence in the request handler used to answer a 500 with
// `message: err.message`, so any uncaught route error handed the caller the
// library's own words. This catch is also behind the unauthenticated access
// route, and a filesystem failure names an absolute path: the caller learned
// where the Gate keeps its state. These tests pin the honest rule -- the
// caller gets a fixed sentence, the detail stays in the Gate's log -- and the
// neighbouring rule that 4xx answers keep their own messages.

// A malformed percent-escape reaches the outer catch through a real route
// (`GET /p/{provider}/v1/models` decodes its path segment before writing
// anything), which is exactly the shape an unreadable file takes: an error
// raised outside every route's own handling. "URI malformed" is the library
// speaking, and it must not be the caller's answer.
const INTERNAL_MESSAGE = 'URI malformed';
const FIXED_MESSAGE = 'The Gate hit an unexpected internal error. The Gate log has the details.';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stubRegistry() {
  const adapter = {
    adapterId: 'stubcli', adapterRevision: '1', supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' }, capabilities: ['sessions', 'tools', 'models'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend() {
      return {
        async listSessions() { return []; },
        async createSession(input) { return { id: 'ses_1', title: input?.title ?? null }; },
        async deleteSession() {},
        async listMessages() { return []; },
        async sendMessage() { return { text: '', message: null }; },
        async listModels() { return []; },
        async abort() {},
        async replyApproval() {},
        async streamEvents() {},
      };
    },
  };
  return {
    get(id) { if (id !== 'stubcli') throw new Error(`unknown CLI adapter "${id}"`); return adapter; },
    list() { return [adapter]; },
  };
}

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-error-redaction-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'stub-local.json'), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id: 'stub-local', label: 'Stub CLI',
    adapterId: 'stubcli', executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  return createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: stubRegistry(),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
}

function auth(gate) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
}

/** A route whose only failure is the uncaught one this file is about. */
function uncaughtFailureUrl(gate) {
  return `http://127.0.0.1:${gate.port}/p/%/v1/models`;
}

test('a 500 answers a fixed message instead of the internal error', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(uncaughtFailureUrl(gate), { headers: auth(gate) });
    // Before the fix this was 500 with `message: "URI malformed"` verbatim.
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, 'Internal Server Error');
    assert.equal(body.message, FIXED_MESSAGE);
    const text = JSON.stringify(body);
    assert.ok(!text.includes(INTERNAL_MESSAGE), 'the response must not echo the internal message');
    assert.ok(!text.includes('URIError'), 'the response must not name the library error');
  } finally {
    await gate.close();
  }
});

test('the internal detail is kept in the Gate log, and the Gate stays up', async () => {
  const gate = await makeGate();
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.map((arg) => String(arg)).join(' ')); };
  try {
    const response = await fetch(uncaughtFailureUrl(gate), { headers: auth(gate) });
    await response.text();
  } finally {
    console.error = originalError;
  }
  try {
    assert.ok(
      logged.some((line) => line.includes('Request handler error') && line.includes(INTERNAL_MESSAGE)),
      'the detail must still reach the Gate log for the operator',
    );
    const health = await fetch(`http://127.0.0.1:${gate.port}/health`);
    assert.equal(health.status, 200, 'a redacted 500 must not take the Gate down');
  } finally {
    await gate.close();
  }
});

test('a 4xx refusal keeps its own message', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(gate),
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'bad_json');
    assert.equal(body.error.message, 'Request body must be valid JSON');
  } finally {
    await gate.close();
  }
});
