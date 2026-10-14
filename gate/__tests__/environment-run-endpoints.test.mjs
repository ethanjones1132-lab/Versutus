import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { verifyInvocationToken } from '../core/cli-environments/invocation-tokens.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

// The endpoint a run's CLI is told to call the Gate back on. A console-started
// Gate (and the Windows Scheduled Task, which spawns `start` with no
// environment) resolves its port itself but never published it, and the
// supervisor derives the endpoint from VERSUTUS_GATE_PORT or from endpoints the
// Gate hands it — so those runs left VERSUTUS_GATE_CHAT out entirely while
// still issuing the invocation token. The port the listener actually bound is
// only known once it is listening, so the test runs a real Gate on port 0 and
// reads back what the spawned child was told.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

/**
 * A Codex-shaped fake that reports the callback it was handed. The probe's own
 * calls run with the Gate's inherited environment; only the run's spawn carries
 * an invocation token, so the report is emitted there.
 */
async function reportingExecutable(directory) {
  const script = join(directory, 'tool.mjs');
  await writeFile(script, `#!/usr/bin/env node
const arg = process.argv.slice(2).join(' ');
if (arg === '--version') {
  if (process.env.VERSUTUS_CLI_INVOCATION_TOKEN) {
    process.stdout.write('ENV ' + JSON.stringify({
      chat: process.env.VERSUTUS_GATE_CHAT ?? null,
      token: process.env.VERSUTUS_CLI_INVOCATION_TOKEN,
    }) + '\\n');
  }
  process.stdout.write('0.142.1\\n');
  process.exit(0);
}
if (arg === 'exec --help') {
  process.stdout.write('--json  Print events to stdout as JSONL\\n');
  process.exit(0);
}
process.stderr.write('unexpected invocation\\n');
process.exit(2);
`, 'utf8');
  await chmod(script, 0o755);
  return script;
}

async function setupGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-env-endpoints-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(root, 'cli'), { recursive: true });
  const gateHome = join(root, '.gate-home');
  const gate = await createGate({ root, port: 0, gateHome });
  const executable = await reportingExecutable(join(root, 'cli'));
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
  assert.equal(created.status, 200, await created.text());
  return { gate, root };
}

const auth = (gate) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${gate.token}`,
});

/** Replay a finished run's own event stream, exactly as a phone would. */
async function collectRunEvents(gate, runId) {
  const response = await fetch(
    `http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs/${runId}/events`,
    { headers: auth(gate) },
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(5).trim()));
}

test('a run on a Gate that never named its port is told the port it calls back on', async () => {
  const previousPort = process.env.VERSUTUS_GATE_PORT;
  // The Gate process is this process, so a developer's own VERSUTUS_GATE_PORT
  // would mask the finding: the port that matters is the one actually bound.
  delete process.env.VERSUTUS_GATE_PORT;
  const { gate, root } = await setupGate();
  try {
    const started = await fetch(`http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({
        operation: 'status',
        providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
        sandbox: 'read_only',
        input: {},
      }),
    });
    const startedBody = await started.text();
    assert.equal(started.status, 200, startedBody);
    const { runId } = JSON.parse(startedBody);

    const events = await collectRunEvents(gate, runId);
    assert.equal(events.at(-1)?.type, 'run.completed', JSON.stringify(events));
    const stdout = events
      .filter((event) => event.type === 'run.output' && event.payload.stream === 'stdout')
      .map((event) => event.payload.text)
      .join('');
    const reported = stdout.split(/\r?\n/).find((line) => line.startsWith('ENV '));
    assert.ok(reported, `the run's stdout must carry what its CLI was told: ${JSON.stringify(stdout)}`);
    const { chat, token } = JSON.parse(reported.slice(4));

    // `port: 0` means only the listener knows the real port; the CLI must be
    // told that one, not left with no route back to the Gate.
    const expected = `http://127.0.0.1:${gate.port}/v1/chat/completions`;
    assert.equal(chat, expected, 'the spawned CLI must be told the port the Gate actually bound');

    // The invocation token rides in the same environment, so its claims must
    // name the same endpoint the child can reach.
    const verified = verifyInvocationToken(token, { runId });
    assert.equal(verified.ok, true, `the invocation token must verify: ${verified.code}`);
    assert.deepEqual(verified.claims.endpoints, { chat: expected });
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    if (previousPort === undefined) delete process.env.VERSUTUS_GATE_PORT;
    else process.env.VERSUTUS_GATE_PORT = previousPort;
  }
});
