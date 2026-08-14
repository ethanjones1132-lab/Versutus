import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalService } from '../core/cli-environments/approvals.mjs';

test('unknown native approval fails closed', async () => {
  const approvals = new ApprovalService();
  const result = await approvals.normalize({ type: 'new-unmapped-risk' });
  assert.equal(result.decision, 'deny');
});

test('read operations auto-approve and credential actions require a one-run decision', async () => {
  const approvals = new ApprovalService();
  const read = await approvals.normalize({ type: 'read', path: 'C:\\Projects\\Versutus\\file.txt' });
  assert.equal(read.decision, 'approve');
  const cred = await approvals.normalize({ type: 'credential', command: 'login' });
  assert.equal(cred.decision, 'pending');
  assert.ok(cred.approvalId);
  const resolved = await approvals.decide(cred.approvalId, 'approve');
  assert.equal(resolved.decision, 'approve');
});

test('bypass and destructive actions never auto-approve', async () => {
  const approvals = new ApprovalService();
  for (const type of ['bypass', 'destructive', 'install', 'system']) {
    const result = await approvals.normalize({ type });
    assert.notEqual(result.decision, 'approve', type);
  }
});
