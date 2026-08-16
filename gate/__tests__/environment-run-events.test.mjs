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

async function collectRunEvents(gate, environmentId, runId) {
  const response = await fetch(
    `http://127.0.0.1:${gate.port}/v1/environments/${environmentId}/runs/${runId}/events`,
    { headers: { Authorization: `Bearer ${gate.token}` } },
  );
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(5).trim()));
}

test('run events have monotonic sequence and one terminal event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-env-events-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const gateHome = join(root, '.gate-home');
  const gate = await createGate({ root, port: 0, gateHome });
  try {
    const executable = await fakeExecutable('0.142.1');
    await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        method: 'environments.create',
        params: validEnvironment({
          id: 'codex-local',
          adapterId: 'codex',
          executable: { path: executable },
          workspacePolicy: {
            roots: [root],
            defaultRoot: root,
            defaultSandbox: 'read_only',
            allowAdditionalRoots: false,
          },
        }),
      }),
    });

    const started = await fetch(`http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        operation: 'status',
        providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
        sandbox: 'read_only',
        input: {},
      }),
    });
    assert.equal(started.status, 200);
    const { runId } = await started.json();
    const events = await collectRunEvents(gate, 'codex-local', runId);
    assert.ok(events.length >= 2);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.equal(events.filter((event) => event.type.startsWith('run.') && /completed|failed|cancelled/.test(event.type)).length, 1);
  } finally {
    await gate.close();
  }
});
