import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';

// VS-004 (QUALITY-SCAN-2026-10-11 MED): `get` awaited `resolveCredentials`
// before the servers-map lookup, so every lookup of an already-running
// environment decrypted the vault again and could re-report an unresolved
// binding through `onCredentialIssue` each time it was asked for. Credentials
// are resolved only while creating the server; a cached server returns without
// touching the vault.

const hermes = {
  id: 'hermes-local',
  label: 'Hermes',
  adapterId: 'hermes',
  enabled: true,
  workspacePolicy: { defaultRoot: '/tmp' },
  credentialBindings: { API_SERVER_KEY: 'hermes/api-key' },
};

const opencode = {
  id: 'opencode-local',
  label: 'OpenCode',
  adapterId: 'opencode',
  enabled: true,
  workspacePolicy: { defaultRoot: '/tmp' },
  credentialBindings: { OPENCODE_SERVER_PASSWORD: 'opencode/pw' },
};

function managerWith({ records, vaultGet, issues, created }) {
  const reads = [];
  const manager = createBackendManager({
    store: {
      get: async (id) => records.find((record) => record.id === id) ?? null,
      list: async () => records,
    },
    registry: {
      get: () => ({
        capabilities: ['chat'],
        server: { transport: 'http' },
        createBackend: ({ credentials, record }) => ({ credentials, id: record.id }),
      }),
    },
    vault: {
      get: async (ref) => {
        reads.push(ref);
        return vaultGet(ref);
      },
    },
    onCredentialIssue: (message) => issues.push(message),
    createServer: ({ record, credentials }) => {
      created.push({ id: record.id, credentials: { ...credentials } });
      const baseUrl = `http://127.0.0.1:${created.length}`;
      return { ensureRunning: async () => ({ baseUrl }), stop: async () => {} };
    },
  });
  return { manager, reads };
}

test('two lookups of one environment create one server and read the vault once', async () => {
  const issues = [];
  const created = [];
  const { manager, reads } = managerWith({
    records: [hermes],
    vaultGet: () => 'v',
    issues,
    created,
  });

  await manager.get('hermes-local');
  await manager.get('hermes-local');

  assert.equal(created.length, 1, 'a cached environment must not create a second server');
  assert.deepEqual(reads, ['hermes/api-key'], 'a cached environment must not read the vault again');
  assert.deepEqual(created[0].credentials, { API_SERVER_KEY: 'v' });
  assert.equal(issues.length, 0);
});

test('a second environment still resolves its own credentials', async () => {
  const issues = [];
  const created = [];
  const { manager, reads } = managerWith({
    records: [hermes, opencode],
    vaultGet: (ref) => (ref === 'hermes/api-key' ? 'v' : 'w'),
    issues,
    created,
  });

  await manager.get('hermes-local');
  await manager.get('hermes-local');
  const second = await manager.get('opencode-local');

  assert.deepEqual(reads, ['hermes/api-key', 'opencode/pw'], 'each environment resolves its own bindings');
  assert.equal(created.length, 2, 'each environment gets its own server');
  assert.deepEqual(second.credentials, { OPENCODE_SERVER_PASSWORD: 'w' });
  assert.deepEqual(created[1].credentials, { OPENCODE_SERVER_PASSWORD: 'w' });
  assert.equal(issues.length, 0);
});

test('two concurrent cold lookups create one server and read the vault once', async () => {
  const issues = [];
  const created = [];
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  const { manager, reads } = managerWith({
    records: [hermes],
    vaultGet: async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'v';
    },
    issues,
    created,
  });

  const first = manager.get('hermes-local');
  await entered;
  const second = manager.get('hermes-local');
  const [a, b] = await Promise.all([first, second]);

  assert.equal(created.length, 1, 'a cold race must not start a second server');
  assert.equal(a, b, 'both callers receive the one backend');
  assert.deepEqual(reads, ['hermes/api-key']);
  assert.deepEqual(created[0].credentials, { API_SERVER_KEY: 'v' });
  assert.equal(issues.length, 0);
});

test('an unresolved optional binding is reported once, not again on the second lookup', async () => {
  const issues = [];
  const created = [];
  const { manager, reads } = managerWith({
    records: [hermes],
    vaultGet: () => undefined,
    issues,
    created,
  });

  await manager.get('hermes-local');
  await manager.get('hermes-local');

  assert.equal(created.length, 1);
  assert.equal(issues.length, 1, 'the unresolved binding is reported at create time only');
  assert.match(issues[0], /hermes-local/);
  assert.match(issues[0], /API_SERVER_KEY -> "hermes\/api-key"/);
  assert.match(issues[0], /no value stored for that reference/);
  assert.deepEqual(reads, ['hermes/api-key']);
  assert.deepEqual(created[0].credentials, {}, 'the failed binding still leaves no credential behind');
});
