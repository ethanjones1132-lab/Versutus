import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';
import { fakeExecutable } from './fixtures/cli-protocols/fake-executable.mjs';

// What the two run-decision routes say when the Gate cannot do what was asked.
// Both used to dress a refusal as a success: `/approve` echoed the literal
// `{ decision: 'deny', reason: 'unknown approval' }` with a 200 for an approval
// it no longer held, and `/cancel` had no catch at all, so a terminate() that
// threw became a bare 500 (and, worse, left the run running forever).

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

async function setupGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-env-decisions-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const gateHome = join(root, '.gate-home');
  const gate = await createGate({ root, port: 0, gateHome });
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
  assert.equal(created.status, 200, await created.text());
  return { gate, root };
}

const auth = (gate) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${gate.token}`,
});

const run = (gate, path) => fetch(`http://127.0.0.1:${gate.port}${path}`, { headers: auth(gate) });

const startRun = (gate, prompt) => fetch(`http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs`, {
  method: 'POST',
  headers: auth(gate),
  body: JSON.stringify({
    operation: 'prompt',
    providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
    sandbox: 'read_only',
    input: { prompt },
  }),
});

const decide = (gate, runId, approvalId, decision) => fetch(
  `http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs/${runId}/approve`,
  { method: 'POST', headers: auth(gate), body: JSON.stringify({ approvalId, decision }) },
);

/** The approval card of a parked run, read off its own event stream. */
async function pendingApproval(gate, runId) {
  const response = await run(gate, `/v1/environments/codex-local/runs/${runId}/events`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    for (const block of seen.split('\n\n')) {
      const line = block.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'approval.required') {
        await reader.cancel().catch(() => {});
        return event.payload.approvalId;
      }
    }
  }
  await reader.cancel().catch(() => {});
  throw new Error(`no approval card on this run: ${JSON.stringify(seen)}`);
}

test('an approval the Gate already decided is a 404 with a code, never a 200 ruling', async () => {
  const { gate, root } = await setupGate();
  try {
    const started = await startRun(gate, 'say hi after the gate');
    assert.equal(started.status, 200);
    const { runId } = await started.json();
    const approvalId = await pendingApproval(gate, runId);

    const first = await decide(gate, runId, approvalId, 'approve');
    assert.equal(first.status, 200, 'the decision that decides it is applied');
    assert.equal((await first.json()).decision, 'approve');

    // The second tap: another device that still had the card rendered, or the
    // same one after the card came back from the Gate's own push. It used to be
    // answered 200 `{ decision: 'deny', reason: 'unknown approval' }` — a ruling
    // applied to nothing, on a body with no `error.code` for the app to read.
    for (const decision of ['approve', 'deny']) {
      const again = await decide(gate, runId, approvalId, decision);
      assert.equal(again.status, 404, `a second ${decision} must not read as applied`);
      const body = await again.json();
      assert.equal(body.error.code, 'unknown_approval');
      assert.match(body.error.message, /Unknown approval/);
    }

    // And an id that never existed (a tap after a restart, the table being in
    // memory) is refused the same honest way rather than ruled on.
    const stale = await decide(gate, runId, 'not-an-approval', 'deny');
    assert.equal(stale.status, 404);
    assert.equal((await stale.json()).error.code, 'unknown_approval');
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test('a cancel that cannot kill the process says so with a real status', async (t) => {
  const { gate, root } = await setupGate();
  try {
    const started = await startRun(gate, 'say hi after the gate');
    const { runId } = await started.json();
    // Parked on a real approval card first: a cancel of a run waiting on
    // consent is the case that denies the card and then kills the tree.
    await pendingApproval(gate, runId);

    // The supervisor's own contract is covered against a real job in
    // cli-supervisor.test.mjs; what this route owes the caller is a status it
    // can act on. The seam is the supervisor method, exactly as the run-events
    // route tests stub `events`.
    t.mock.method(CliEnvironmentService.prototype, 'cancel', async () => {
      throw Object.assign(new Error('taskkill failed: access denied'), { status: 502, code: 'run_terminate_failed' });
    });

    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs/${runId}/cancel`, {
      method: 'POST', headers: auth(gate),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'run_terminate_failed');
    assert.match(body.error.message, /taskkill failed/);
    assert.ok(!body.error.message.includes('Internal'), 'never the generic handler envelope');

    // The Gate still answers afterwards: a refusal is a status, not a crash.
    const runs = await run(gate, '/v1/environments/codex-local/runs');
    assert.equal(runs.status, 200);
    await runs.json();
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});