import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Registration used to require the desktop CLI plus a hand-edited JSON file
 * because nothing told a client which provider profiles or CLI adapters the
 * Gate actually ships. These two methods are what let the app offer a picker.
 */
async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-discovery-'));
  roots.push(root);
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  return createGate({ root, port: 0, gateHome: join(root, '.gate-home') });
}

async function rpc(gate, method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('providers.profiles.list advertises every shipped profile with a prefillable base URL', async () => {
  const gate = await makeGate();
  try {
    const { status, body } = await rpc(gate, 'providers.profiles.list');
    assert.equal(status, 200);
    const profiles = body.result.profiles;
    assert.deepEqual(
      profiles.map((profile) => profile.id).sort(),
      ['anthropic', 'nvidia-nim', 'openai', 'openai-compatible', 'xai'],
    );
    // The escape hatch for any OpenAI-dialect endpoint: no canonical host to
    // guess, so the operator supplies the base URL and it becomes the allowlist.
    const compatible = profiles.find((profile) => profile.id === 'openai-compatible');
    assert.equal(compatible.defaultBaseUrl, undefined);
    assert.deepEqual(compatible.origins, []);
    const nim = profiles.find((profile) => profile.id === 'nvidia-nim');
    assert.equal(nim.label, 'NVIDIA NIM');
    assert.equal(nim.protocol, 'openai_chat');
    assert.equal(nim.mode, 'api_key');
    assert.equal(nim.defaultBaseUrl, 'https://integrate.api.nvidia.com/v1');
    // Never leak the credential-handling functions over the wire.
    assert.equal(nim.authHeaders, undefined);
    assert.equal(nim.parseModels, undefined);
  } finally {
    await gate.close();
  }
});

test('environments.adapters.list advertises the CLI adapters, including opencode', async () => {
  const gate = await makeGate();
  try {
    const { status, body } = await rpc(gate, 'environments.adapters.list');
    assert.equal(status, 200);
    const adapters = body.result.adapters;
    assert.deepEqual(
      adapters.map((adapter) => adapter.adapterId).sort(),
      ['claude-code', 'codex', 'hermes', 'opencode'],
    );
    const opencode = adapters.find((adapter) => adapter.adapterId === 'opencode');
    assert.equal(opencode.supportedCliVersions, '1.17.x-1.18.x');
    assert.deepEqual(opencode.protocols.sort(), ['acp', 'jsonl']);
    assert.ok(opencode.operations.includes('prompt'));
    // startRun/probe are server-side functions, not wire data.
    assert.equal(opencode.probe, undefined);
  } finally {
    await gate.close();
  }
});
