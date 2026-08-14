import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

async function postChat(gate, body) {
  return fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gate.token}`,
    },
    body: JSON.stringify(body),
  });
}

async function gateWithDuplicateModel() {
  const root = await mkdtemp(join(tmpdir(), 'gate-model-route-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  for (const id of ['alpha', 'beta']) {
    await writeFile(join(root, 'registry', `${id}.json`), JSON.stringify({
      kind: 'provider',
      label: id,
      config: {
        flavor: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyEnv: `${id.toUpperCase()}_KEY`,
        models: ['shared-model'],
        streaming: true,
      },
    }), 'utf8');
  }
  return createGate({ root, port: 0, gateHome: join(root, '.gate-home') });
}

test('unscoped duplicate model requires providerId', async () => {
  const gate = await gateWithDuplicateModel();
  try {
    const response = await postChat(gate, { model: 'shared-model', messages: [] });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'ambiguous_model');
  } finally {
    await gate.close();
  }
});

test('qualified providerId selects the intended duplicate model owner', async () => {
  const gate = await gateWithDuplicateModel();
  try {
    const response = await postChat(gate, {
      model: 'shared-model',
      providerId: 'beta',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.notEqual(response.status, 409);
  } finally {
    await gate.close();
  }
});
