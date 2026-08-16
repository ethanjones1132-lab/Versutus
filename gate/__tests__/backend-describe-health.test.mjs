import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';

const RECORD = {
  id: 'opencode-local',
  label: 'OpenCode',
  adapterId: 'opencode',
  enabled: true,
  executable: { path: 'C:\\tools\\opencode.exe' },
  workspacePolicy: { defaultRoot: 'C:\\Projects' },
};

function manager(environmentState) {
  return createBackendManager({
    store: { list: async () => [RECORD] },
    registry: {
      get: () => ({
        capabilities: ['sessions', 'tools', 'models'],
        server: { transport: 'http' },
        createBackend: () => ({}),
      }),
    },
    environmentState,
  });
}

test('describe carries the health the picker needs', async () => {
  const state = new Map([['opencode-local', { state: 'ready', probe: { cliVersion: '1.18.18' } }]]);
  const [backend] = await manager(state).describe();
  assert.equal(backend.state, 'ready');
  assert.equal(backend.cliVersion, '1.18.18');
  assert.deepEqual(backend.capabilities, ['sessions', 'tools', 'models']);
});

test('an unprobed environment falls back to its enabled flag', async () => {
  const [backend] = await manager(new Map()).describe();
  assert.equal(backend.state, 'stopped');
  assert.equal(backend.cliVersion, undefined);
});

test('describe never leaks the executable path', async () => {
  const [backend] = await manager(new Map()).describe();
  assert.equal(backend.executable, undefined);
  assert.doesNotMatch(JSON.stringify(backend), /opencode\.exe/);
});
