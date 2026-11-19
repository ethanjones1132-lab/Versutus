import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApprovalService } from '../core/cli-environments/approvals.mjs';
import { createApprovalRpc } from '../core/approvals/rpc.mjs';
import { createDecisionLedger } from '../core/approvals/decision-ledger.mjs';
import { AUDIT_MAX_AGE_MS, deviceTag } from '../core/voice/audit.mjs';

const DEVICE = { deviceId: 'device-1' };

test('approvals.pending lists a pending approval with its class and summary', async () => {
  const approvals = new ApprovalService();
  await approvals.normalize({
    type: 'workspace_write',
    runId: 'run-1',
    environmentId: 'env-1',
    operation: 'prompt',
    summary: 'writes files',
  });
  const rpc = createApprovalRpc({ approvals });
  const result = await rpc.methods['approvals.pending']({}, DEVICE);
  assert.equal(result.approvals.length, 1);
  assert.deepEqual(
    {
      type: result.approvals[0].type,
      runId: result.approvals[0].runId,
      operation: result.approvals[0].operation,
      summary: result.approvals[0].summary,
    },
    { type: 'workspace_write', runId: 'run-1', operation: 'prompt', summary: 'writes files' },
  );
});

test('approvals.pending never exposes the raw request bag', async () => {
  const approvals = new ApprovalService();
  await approvals.normalize({
    type: 'credential',
    runId: 'r',
    environmentId: 'e',
    operation: 'login',
    summary: 'needs creds',
    secret: 'should-not-leak',
  });
  const rpc = createApprovalRpc({ approvals });
  const row = (await rpc.methods['approvals.pending']({}, DEVICE)).approvals[0];
  assert.equal('request' in row, false);
  assert.equal(JSON.stringify(row).includes('should-not-leak'), false);
});

test('approval.approve resolves the waiting run and clears the list', async () => {
  const approvals = new ApprovalService();
  const entry = await approvals.normalize({
    type: 'destructive',
    runId: 'r',
    environmentId: 'e',
    operation: 'rm',
  });
  const waiting = approvals.waitForDecision(entry.approvalId);
  const rpc = createApprovalRpc({ approvals });
  const result = await rpc.methods['approval.approve']({ approvalId: entry.approvalId }, DEVICE);
  assert.equal(result.decision, 'approve');
  assert.equal((await waiting).decision, 'approve');
  assert.equal((await rpc.methods['approvals.pending']({}, DEVICE)).approvals.length, 0);
});

test('approval.deny fails closed on an unknown id', async () => {
  const rpc = createApprovalRpc({ approvals: new ApprovalService() });
  await assert.rejects(rpc.methods['approval.deny']({ approvalId: 'nope' }, DEVICE), /Unknown approval/);
});

test('approval methods require a paired device', async () => {
  const rpc = createApprovalRpc({ approvals: new ApprovalService() });
  await assert.rejects(rpc.methods['approvals.pending']({}, {}), /paired device/);
  await assert.rejects(rpc.methods['approval.approve']({ approvalId: 'x' }, {}), /paired device/);
});

test('a read-only operation is auto-approved and never listed', async () => {
  const approvals = new ApprovalService();
  const entry = await approvals.normalize({
    type: 'read',
    runId: 'r',
    environmentId: 'e',
    operation: 'status',
  });
  assert.equal(entry.decision, 'approve');
  const rpc = createApprovalRpc({ approvals });
  assert.equal((await rpc.methods['approvals.pending']({}, DEVICE)).approvals.length, 0);
});

// The phone holds the Gate's own (bootstrap) token, not a paired-device grant.
// That token is already full operator access — push-rpc.mjs accepts it for the
// same reason — so refusing it the approval inbox protected nothing and left
// Activity's "Needs you" permanently reading "A paired device grant is required".
const BOOTSTRAP = { deviceId: null, bootstrap: true };

test('a caller holding the Gate\'s own token reads and decides approvals', async () => {
  const approvals = new ApprovalService();
  const entry = await approvals.normalize({ type: 'destructive', runId: 'r', environmentId: 'e', operation: 'rm' });
  const rpc = createApprovalRpc({ approvals });
  const pending = await rpc.methods['approvals.pending']({}, BOOTSTRAP);
  assert.equal(pending.approvals.length, 1);
  const waiting = approvals.waitForDecision(entry.approvalId);
  const result = await rpc.methods['approval.deny']({ approvalId: entry.approvalId }, BOOTSTRAP);
  assert.equal(result.decision, 'deny');
  assert.equal((await waiting).decision, 'deny');
});

test('a caller with neither a grant nor the Gate\'s token is still refused', async () => {
  const rpc = createApprovalRpc({ approvals: new ApprovalService() });
  for (const ctx of [undefined, {}, { deviceId: null, bootstrap: false }, { deviceId: '' }]) {
    await assert.rejects(rpc.methods['approvals.pending']({}, ctx), (error) => error.code === 'pairing_required' && error.status === 403);
  }
});

function onDisk(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vs143-decisions-'));
  const ledger = createDecisionLedger({ dir, ...opts });
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, ledger, approvals: new ApprovalService({ ledger, now: opts.now }) };
}

const voiceAction = {
  backendId: 'claude-dev', botId: 'draft-checker', deviceId: DEVICE.deviceId,
  sessionId: 'native-private-session-id',
  transcript: 'NEVER-STORE-UTTERANCE', pcm: 'NEVER-STORE-PCM',
  input: { contents: 'NEVER-STORE-FILE', token: 'NEVER-STORE-SECRET' },
  output: 'NEVER-STORE-OUTPUT',
};

test('Gate holds every non-read action (including unknown) and records before releasing execution', async (t) => {
  const { approvals, ledger } = onDisk(t);
  const { methods } = createApprovalRpc({ approvals });
  assert.equal(await approvals.authorize({ ...voiceAction, tool: 'Read' }), true);
  assert.equal(approvals.list(DEVICE).length, 0);
  const classes = [
    ['Write', 'workspace_write'], ['Bash', 'shell_exec'], ['WebFetch', 'network_write'],
    ['mcp__some__thing', 'connector'], ['credential', 'credential_system'], ['new_tool', 'unknown'],
  ];
  for (const [tool, actionClass] of classes) {
    for (const decision of ['approve', 'deny']) {
      const mayRun = decision === 'approve' && actionClass !== 'unknown';
      let executed = false;
      const events = [];
      const running = approvals.authorize({ ...voiceAction, tool, announce: (entry) => events.push(entry) }).then((allowed) => {
        assert.equal(ledger.recent(1)[0].decision, mayRun ? 'approved' : 'denied');
        if (allowed) executed = true;
      });
      const { approvalId, summary, type } = approvals.list(DEVICE)[0];
      assert.equal(type, actionClass);
      assert.equal(executed, false);
      assert.equal(events[0].state, 'pending');
      assert.equal(approvals.list({ deviceId: 'other' }).length, 0);
      await assert.rejects(approvals.decide(approvalId, 'approve'), { code: 'approval_owner_mismatch' });
      await methods[`approval.${decision}`]({ approvalId }, DEVICE);
      await running;
      assert.equal(executed, mayRun);
      assert.equal(events[1].summary, summary);
      const row = ledger.recent(1)[0];
      assert.equal(row.approvalId, approvalId);
      assert.equal(row.source, 'voice');
      assert.equal(row.backend, 'claude-dev');
      assert.equal(row.bot, 'draft-checker');
      assert.equal(row.tool, tool);
      assert.equal(row.actionClass, actionClass);
      assert.equal(row.summary, summary);
      assert.ok(Buffer.byteLength(row.summary) <= 240);
      assert.equal(row.decidedBy, deviceTag(DEVICE.deviceId));
    }
  }
  const contents = readFileSync(ledger.path, 'utf8');
  assert.equal(contents.trim().split('\n').length, 1 + classes.length * 2);
  assert.doesNotMatch(contents, /NEVER-STORE|native-private-session-id|device-1/);
  assert.deepEqual(Object.keys(ledger.recent(1)[0]).sort(), [
    'approvalId', 'requestedAt', 'decidedAt', 'decision', 'source', 'backend', 'bot',
    'sessionTag', 'actionClass', 'tool', 'summary', 'decidedBy', 'latencyMs',
  ].sort());
});

test('voice expiry denies at 30 seconds and refuses an answer after the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { approvals, ledger } = onDisk(t, { now: () => Date.now() });
  const { methods } = createApprovalRpc({ approvals });
  const events = [];
  const waiting = approvals.authorize({ ...voiceAction, tool: 'Write', announce: (event) => events.push(event) });
  const approvalId = events[0].approvalId;
  t.mock.timers.tick(29_999);
  assert.ok(approvals.get(approvalId));
  t.mock.timers.tick(1);
  assert.equal(await waiting, false);
  await assert.rejects(methods['approval.approve']({ approvalId }, DEVICE), { code: 'unknown_approval' });
  assert.deepEqual(events.map((event) => event.state), ['pending', 'expired']);
  assert.deepEqual(ledger.recent().map((row) => [row.decision, row.latencyMs, row.decidedBy]), [['expired', 30_000, null]]);
});

test('an abort withdraws and a restart denies pending decisions exactly once', async (t) => {
  const { approvals, ledger, dir } = onDisk(t);
  const signal = new AbortController();
  const cancelled = approvals.authorize({ ...voiceAction, tool: 'Write', signal: signal.signal });
  signal.abort();
  assert.equal(await cancelled, false);
  const stopped = approvals.authorize({ ...voiceAction, tool: 'Write' });
  approvals.close();
  assert.equal(await stopped, false);
  assert.deepEqual(ledger.recent().map((row) => row.decision), ['gate-restart', 'withdrawn']);

  // Simulate process death: a marker was flushed, but no completion ran.
  const first = createDecisionLedger({ dir });
  const abandoned = new ApprovalService({ ledger: first });
  const pending = await abandoned.normalize({ type: 'workspace_write', operation: 'Edit', ...voiceAction });
  first.close();
  const second = createDecisionLedger({ dir });
  t.after(() => second.close());
  const fresh = new ApprovalService({ ledger: second });
  const { methods } = createApprovalRpc({ approvals: fresh });
  assert.deepEqual((await methods['approvals.pending']({}, DEVICE)).approvals, []);
  await assert.rejects(methods['approval.approve']({ approvalId: pending.approvalId }, DEVICE), { code: 'unknown_approval' });
  const recovered = second.recent().filter((row) => row.approvalId === pending.approvalId);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].decision, 'gate-restart');
});

test('the decision ledger rotates, prunes beyond 30 days and returns recent decisions by RPC', async (t) => {
  let at = Date.now();
  const { approvals, ledger } = onDisk(t, { now: () => at, maxBytes: 1 });
  const { methods } = createApprovalRpc({ approvals });
  const decideTyped = async () => {
    const { approvalId } = await approvals.normalize({ type: 'workspace_write', operation: 'Edit', summary: 'NEVER-STORE-FILE' });
    await methods['approval.deny']({ approvalId }, DEVICE);
    return approvalId;
  };
  const old = await decideTyped();
  at += AUDIT_MAX_AGE_MS - 1;
  const newest = await decideTyped();
  assert.equal(existsSync(`${ledger.path}.1`), true);
  assert.deepEqual(ledger.recent().map((row) => row.approvalId), [newest, old]);
  at += 2;
  await assert.rejects(methods['approvals.decisions']({}, {}), { code: 'pairing_required' });
  const { decisions } = await methods['approvals.decisions']({ limit: 2 }, DEVICE);
  assert.deepEqual(decisions.map((row) => [row.approvalId, row.source]), [[newest, 'typed']]);
  const restarted = createDecisionLedger({ dir: join(ledger.path, '..'), now: () => at });
  t.after(() => restarted.close());
  assert.equal(existsSync(`${ledger.path}.1`), false);
  assert.doesNotMatch(readFileSync(ledger.path, 'utf8'), /NEVER-STORE-FILE/);
});
