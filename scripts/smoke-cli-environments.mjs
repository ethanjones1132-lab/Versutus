import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../gate/core/server.mjs';
import { validEnvironment } from '../gate/__tests__/fixtures/cli-environment.mjs';
import { fakeExecutable } from '../gate/__tests__/fixtures/cli-protocols/fake-executable.mjs';

const kindModulePath = fileURLToPath(new URL('../gate/core/capabilities/provider/kind.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'smoke-cli-'));
await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
await mkdir(join(root, 'registry'), { recursive: true });
const gateHome = join(root, 'home');
const gate = await createGate({ root, gateHome, port: 0 });

try {
  const executable = await fakeExecutable('0.142.1');
  const created = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
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
  if (created.status !== 200) throw new Error(`create ${created.status}`);

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
  if (started.status !== 200) throw new Error(`run ${started.status}`);
  const { runId } = await started.json();
  const events = await fetch(`http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs/${runId}/events`, {
    headers: { Authorization: `Bearer ${gate.token}` },
  });
  const text = await events.text();
  if (!text.includes('run.started') || !text.includes('run.completed')) {
    throw new Error('missing terminal run events');
  }

  const rejected = await fetch(`http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspacePath: 'C:\\\\Windows\\\\System32',
      sandbox: 'read_only',
      input: {},
    }),
  });
  if (rejected.status === 200) throw new Error('escaped workspace was accepted');
  console.log('smoke-cli-environments: PASS');
} finally {
  await gate.close();
  await rm(root, { recursive: true, force: true });
}
