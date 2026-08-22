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

test('environment listings expose vault references, and updates never wipe what a client cannot see', async () => {
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
      credentialBindings: { ANTHROPIC_API_KEY: 'provider/anthropic-main/api-key' },
    }));
    assert.equal(created.status, 200);
    assert.equal(created.body.result.ok, true);

    // The listing carries the env-var -> vault-reference mapping so a client
    // can extend it without hand-editing JSON. References only: the secret
    // value never enters the record, so it cannot leak through a listing.
    const listed = await rpc(gate, 'environments.list', {});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result.environments[0].credentialBindings, {
      ANTHROPIC_API_KEY: 'provider/anthropic-main/api-key',
    });

    // An update that says nothing about bindings leaves the mapping alone —
    // a client on an older snapshot must not wipe what it cannot see.
    await rpc(gate, 'environments.update', { id: 'hermes-local', label: 'Hermes renamed' });
    const after = await rpc(gate, 'environments.list', {});
    assert.equal(
      after.body.result.environments[0].credentialBindings.ANTHROPIC_API_KEY,
      'provider/anthropic-main/api-key',
    );

    // Clearing is explicit: an empty map removes every binding.
    await rpc(gate, 'environments.update', { id: 'hermes-local', credentialBindings: {} });
    const cleared = await rpc(gate, 'environments.list', {});
    assert.deepEqual(cleared.body.result.environments[0].credentialBindings, {});
  } finally {
    await gate.close();
  }
});
