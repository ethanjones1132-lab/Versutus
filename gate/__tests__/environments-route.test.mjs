import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';
import { fakeExecutable } from './fixtures/cli-protocols/fake-executable.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

async function startGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-env-route-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const gateHome = join(root, '.gate-home');
  const gate = await createGate({ root, port: 0, gateHome });
  return { gate, root, gateHome };
}

async function rpc(gate, method, params) {
  const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, body: await response.json() };
}

test('environments RPC creates a sanitized environment listing', async () => {
  const { gate } = await startGate();
  try {
    const executable = await fakeExecutable('0.142.1');
    const created = await rpc(gate, 'environments.create', validEnvironment({
      executable: { path: executable },
      workspacePolicy: {
        roots: [process.cwd()],
        defaultRoot: process.cwd(),
        defaultSandbox: 'read_only',
        allowAdditionalRoots: false,
      },
    }));
    assert.equal(created.status, 200);
    assert.equal(created.body.result.ok, true);

    const list = await fetch(`http://127.0.0.1:${gate.port}/v1/environments`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.environments[0].id, 'hermes-local');
    assert.equal(JSON.stringify(body).includes('OPENAI_API_KEY'), false);
  } finally {
    await gate.close();
  }
});
