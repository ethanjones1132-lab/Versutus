import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

test('an empty-model provider does not turn unknown_model into a server error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-empty-provider-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(join(root, 'registry', 'empty.json'), JSON.stringify({
    kind: 'provider', label: 'Empty',
    config: { flavor: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'EMPTY_PROVIDER_KEY', models: [] },
  }));
  process.env.EMPTY_PROVIDER_KEY = 'test-key';
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'not-declared', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'unknown_model');
  } finally {
    await gate.close();
  }
});
