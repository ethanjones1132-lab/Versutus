import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalService } from '../core/cli-environments/approvals.mjs';
import { createApprovalRpc } from '../core/approvals/rpc.mjs';
import { createOpenCodeBackend, normalizeOpenCodeEvent } from '../core/cli-environments/backends/opencode.mjs';
import { assertOpenCodeReply, createOpenCodePermissionBridge } from '../core/cli-environments/opencode-permissions.mjs';

const DEVICE = { deviceId: 'device-1' };
const owner = { backendId: 'oc-local', environmentId: 'oc-local', botId: 'writer', runId: 'ses_1', sessionId: 'ses_1' };

function asked(type = 'permission.asked') {
  const legacy = type === 'permission.asked';
  return {
    type,
    properties: {
      id: 'per_1',
      sessionID: 'ses_1',
      ...(legacy
        ? { permission: 'bash', patterns: ['git status', 'src/**'], always: ['src/**'], metadata: { command: 'git status' }, tool: { messageID: 'msg_1', callID: 'call_1' } }
        : { action: 'bash', resources: ['git status', 'src/**'], save: ['src/**'], metadata: { command: 'git status' }, source: { type: 'tool', messageID: 'msg_1', id: 'call_1' } }),
    },
  };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

for (const eventType of ['permission.asked', 'permission.v2.asked']) {
  test(`${eventType} enters the inbox with OpenCode context and only approve maps to once`, async () => {
    const approvals = new ApprovalService();
    const posted = [];
    const bridge = createOpenCodePermissionBridge({
      approvals,
      ...owner,
      replyApproval: async (...args) => posted.push(args),
    });
    const askedWork = bridge.asked(asked(eventType), 'writer');
    await nextTurn();
    const [row] = approvals.list();
    assert.deepEqual(
      { backendId: row.backendId, botId: row.botId, sessionId: row.sessionId, permission: row.context.permission,
        command: row.context.command, resources: row.context.resources, source: row.context.source },
      { backendId: 'oc-local', botId: 'writer', sessionId: 'ses_1', permission: 'bash',
        command: 'git status', resources: ['git status', 'src/**'],
        source: eventType === 'permission.asked'
          ? { messageID: 'msg_1', callID: 'call_1' }
          : { type: 'tool', messageID: 'msg_1', id: 'call_1' } },
    );
    const rpc = createApprovalRpc({ approvals });
    await rpc.methods['approval.approve']({ approvalId: row.approvalId }, DEVICE);
    await askedWork;
    assert.deepEqual(posted, [['ses_1', 'per_1', 'once']]);
  });
}

test('reject maps to reject and a request resolved by another OpenCode client cannot be decided', async () => {
  const approvals = new ApprovalService();
  const posted = [];
  const bridge = createOpenCodePermissionBridge({ approvals, ...owner, replyApproval: async (...args) => posted.push(args) });
  const work = bridge.asked(asked('permission.v2.asked'), 'writer');
  await nextTurn();
  const [row] = approvals.list();
  const rpc = createApprovalRpc({ approvals });
  await rpc.methods['approval.deny']({ approvalId: row.approvalId }, DEVICE);
  await work;
  assert.deepEqual(posted, [['ses_1', 'per_1', 'reject']]);

  const another = bridge.asked({ ...asked(), properties: { ...asked().properties, id: 'per_2' } }, 'writer');
  await nextTurn();
  const stale = approvals.list()[0];
  bridge.replied({ type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: 'per_2', reply: 'once' } });
  await another;
  await assert.rejects(rpc.methods['approval.approve']({ approvalId: stale.approvalId }, DEVICE), (error) => error.status === 404);
  assert.deepEqual(posted, [['ses_1', 'per_1', 'reject']]);
});

test('a pending OpenCode request missing on reconnect is withdrawn and refuses a late decision', async () => {
  const approvals = new ApprovalService();
  const posted = [];
  const bridge = createOpenCodePermissionBridge({ approvals, ...owner, replyApproval: async (...args) => posted.push(args) });
  const work = bridge.asked(asked('permission.v2.asked'), 'writer');
  await nextTurn();
  const [row] = approvals.list();
  bridge.reconcile('ses_1', []);
  await work;
  const rpc = createApprovalRpc({ approvals });
  await assert.rejects(rpc.methods['approval.approve']({ approvalId: row.approvalId }, DEVICE), (error) => error.status === 404);
  assert.deepEqual(posted, []);
});

test('permission.v2.replied withdraws its matching session request', async () => {
  const approvals = new ApprovalService();
  const bridge = createOpenCodePermissionBridge({ approvals, ...owner, replyApproval: async () => assert.fail('must not reply') });
  const work = bridge.asked(asked('permission.v2.asked'), 'writer');
  await nextTurn();
  const [row] = approvals.list();
  bridge.replied({ type: 'permission.v2.replied', data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' } });
  await work;
  assert.equal(approvals.get(row.approvalId), null);
});

test('a reply answered with OpenCode 404 makes the inbox decision fail and removes the stale row', async () => {
  const approvals = new ApprovalService();
  const bridge = createOpenCodePermissionBridge({
    approvals,
    ...owner,
    replyApproval: async () => { throw Object.assign(new Error('Permission request not found'), { status: 404 }); },
  });
  const work = bridge.asked(asked('permission.v2.asked'), 'writer');
  await nextTurn();
  const [row] = approvals.list();
  const rpc = createApprovalRpc({ approvals });
  await assert.rejects(rpc.methods['approval.approve']({ approvalId: row.approvalId }, DEVICE),
    (error) => error.status === 404);
  await work;
  await assert.rejects(rpc.methods['approval.approve']({ approvalId: row.approvalId }, DEVICE),
    (error) => error.status === 404);
});

test('OpenCode inbox decisions naming another backend, Bot, or session are refused before forwarding', async () => {
  const approvals = new ApprovalService();
  let forwarded = false;
  const entry = await approvals.normalize({
    type: 'workspace_write', adapterId: 'opencode', ...owner,
    onDecision: async () => { forwarded = true; },
  });
  const rpc = createApprovalRpc({ approvals });
  for (const claim of [
    { backendId: 'other' }, { environmentId: 'other' }, { botId: 'other' }, { sessionId: 'ses_other' },
  ]) {
    await assert.rejects(rpc.methods['approval.approve']({ approvalId: entry.approvalId, ...claim }, DEVICE),
      (error) => error.status === 403 && error.code === 'approval_owner_mismatch');
    assert.ok(approvals.get(entry.approvalId));
  }
  assert.equal(forwarded, false);
});

test('the OpenCode decision route and reply backend reject always and unknown values', async () => {
  const approvals = new ApprovalService();
  const entry = await approvals.normalize({ type: 'workspace_write', adapterId: 'opencode', ...owner });
  const rpc = createApprovalRpc({ approvals });
  for (const bad of ['always', 'allow', 'unknown']) {
    await assert.rejects(rpc.methods['approval.approve']({ approvalId: entry.approvalId, decision: bad }, DEVICE),
      (error) => error.status === 400 && error.code === 'invalid_approval_decision');
  }
  await assert.rejects(rpc.methods['approval.approve']({ approvalId: entry.approvalId, reply: 'always' }, DEVICE),
    (error) => error.status === 400 && error.code === 'invalid_approval_decision');
  await assert.rejects(rpc.methods['approval.approve']({ approvalId: entry.approvalId, decision: 'reject' }, DEVICE),
    (error) => error.status === 400 && error.code === 'invalid_approval_decision');
  const requests = [];
  const backend = createOpenCodeBackend({
    baseUrl: 'http://opencode.test',
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  for (const bad of ['always', 'unknown']) {
    await assert.rejects(backend.replyApproval('ses_1', 'per_1', bad),
      (error) => error.status === 400 && error.code === 'invalid_permission_reply');
  }
  assert.equal(requests.some((url) => url.includes('/permission/per_1/reply')), false);
  assert.doesNotThrow(() => assertOpenCodeReply('once'));
  assert.doesNotThrow(() => assertOpenCodeReply('reject'));
  assert.ok(approvals.get(entry.approvalId));
});

for (const major of [1, 2]) {
  test(`OpenCode ${major === 1 ? 'v1' : 'v2'} reply route sends only once and reject`, async () => {
    const posts = [];
    const backend = createOpenCodeBackend({
      baseUrl: 'http://opencode.test',
      fetchImpl: async (url, init = {}) => {
        const target = String(url);
        if (target.endsWith('/session')) {
          return major === 1
            ? new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
            : new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } });
        }
        if (target.endsWith('/api/info')) {
          return new Response('{"version":"2.0.32"}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        posts.push({ url: target, method: init.method, body: JSON.parse(init.body) });
        return new Response(null, { status: major === 1 ? 200 : 204 });
      },
    });
    await backend.replyApproval('ses_1', 'per_1', 'once');
    await backend.replyApproval('ses_1', 'per_2', 'reject');
    assert.deepEqual(posts.map((post) => post.body), [{ reply: 'once' }, { reply: 'reject' }]);
    assert.ok(posts.every((post) => post.method === 'POST'));
    assert.ok(posts.every((post) => post.url.includes(major === 1 ? '/session/ses_1/permission/' : '/api/session/ses_1/permission/')));
  });
}

test('approval.required frames retain permission, scope, session, backend, and Bot context', () => {
  const normalized = normalizeOpenCodeEvent(asked('permission.v2.asked'), undefined, owner);
  assert.deepEqual(normalized.payload, {
    sessionId: 'ses_1', approvalId: 'per_1', action: 'bash', permission: 'bash',
    tool: { type: 'tool', messageID: 'msg_1', id: 'call_1' }, command: 'git status',
    resources: ['git status', 'src/**'], patterns: [], save: ['src/**'], metadata: { command: 'git status' },
    source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
    session: 'ses_1', backendId: 'oc-local', botId: 'writer',
  });
});
