import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';

// Issue #1 item 2: on a Mac the vault could not decrypt, the read was caught
// and dropped, and Hermes attached without its API_SERVER_KEY -- every call
// not tied to a bot then answered 401 with nothing anywhere saying why.

const RECORD = {
  id: 'hermes-local',
  label: 'Hermes',
  adapterId: 'hermes',
  enabled: true,
  executable: { path: '/usr/local/bin/hermes' },
  workspacePolicy: { defaultRoot: '/tmp' },
  credentialBindings: { API_SERVER_KEY: 'hermes/api-key', OPENROUTER_API_KEY: 'openrouter/main' },
};

function managerWith(vault, issues, servers) {
  return createBackendManager({
    store: { get: async () => RECORD, list: async () => [RECORD] },
    registry: {
      get: () => ({
        capabilities: ['chat'],
        server: { transport: 'http' },
        createBackend: ({ credentials }) => ({ credentials }),
      }),
    },
    vault,
    onCredentialIssue: (message, detail) => issues.push({ message, detail }),
    createServer: ({ credentials }) => {
      servers.push(credentials);
      return { ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1' }), stop: async () => {} };
    },
  });
}

test('a binding the vault cannot read is reported by name and cause, never by value', async () => {
  const issues = [];
  const servers = [];
  const vault = {
    async get(ref) {
      if (ref === 'hermes/api-key') {
        throw Object.assign(new Error('DPAPI unprotect failed: spawn powershell.exe ENOENT'), { code: 'credential_unreadable' });
      }
      return 'sk-or-secret-value';
    },
  };
  const backend = await managerWith(vault, issues, servers).get('hermes-local');

  assert.deepEqual(backend.credentials, { OPENROUTER_API_KEY: 'sk-or-secret-value' });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /hermes-local/);
  assert.match(issues[0].message, /API_SERVER_KEY -> "hermes\/api-key"/);
  assert.match(issues[0].message, /credential_unreadable: DPAPI unprotect failed/);
  assert.deepEqual(issues[0].detail, { environmentId: 'hermes-local', envName: 'API_SERVER_KEY', ref: 'hermes/api-key' });
  for (const issue of issues) assert.ok(!issue.message.includes('sk-or-secret-value'));
});

test('a binding with nothing stored is reported too, as a different cause', async () => {
  const issues = [];
  const vault = { async get(ref) { return ref === 'hermes/api-key' ? undefined : 'v'; } };
  await managerWith(vault, issues, []).get('hermes-local');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /no value stored for that reference/);
});

test('fully resolved bindings report nothing', async () => {
  const issues = [];
  const servers = [];
  const backend = await managerWith({ async get() { return 'v'; } }, issues, servers).get('hermes-local');
  assert.deepEqual(issues, []);
  assert.deepEqual(backend.credentials, { API_SERVER_KEY: 'v', OPENROUTER_API_KEY: 'v' });
  assert.deepEqual(servers[0], { API_SERVER_KEY: 'v', OPENROUTER_API_KEY: 'v' });
});
