import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalService } from '../core/cli-environments/approvals.mjs';
import { createApprovalRpc } from '../core/approvals/rpc.mjs';

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
