import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';
import { createStdioServer } from '../core/cli-environments/stdio-server.mjs';
import { codexAdapter } from '../core/cli-environments/adapters/codex.mjs';
import { ApprovalService } from '../core/cli-environments/approvals.mjs';

/**
 * An approval is a server request on the Codex app-server pipe. It stays
 * unanswered until the operator rules, and the ruling goes back as `accept`
 * or `decline`. An empty result grants the command.
 */

const RECORD = {
  id: 'codex-local',
  enabled: true,
  adapterId: 'codex',
  executable: { path: 'C:\\tools\\codex.exe' },
  workspacePolicy: { defaultRoot: 'C:\\ws' },
};

/** A child whose stdin we can read. A write with a method is the handshake. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.write = (text) => {
    const message = JSON.parse(text);
    child.written.push(message);
    if (message.method) {
      child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
    }
    return true;
  };
  child.stdin = stdin;
  child.kill = () => { child.emit('exit', 0); };
  return child;
}

function reply(child, id) {
  return child.written.find((message) => message.id === id);
}

function wait() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * `approvals` omitted from the argument means the default service. Passing
 * `approvals: undefined` builds the manager with no approvals property.
 */
function codexManager(options = {}) {
  let child = null;
  const includeApprovals = !Object.hasOwn(options, 'approvals');
  const approvals = includeApprovals ? new ApprovalService() : options.approvals;
  const manager = createBackendManager({
    store: {
      async get(id) {
        return id === RECORD.id ? RECORD : null;
      },
    },
    registry: { get: () => codexAdapter },
    ...(approvals ? { approvals } : {}),
    createServer({
      record,
      adapter,
      onNotification,
      onServerRequest,
      credentials,
      buildEnvironment,
      onDiagnostic,
    }) {
      return createStdioServer({
        record,
        adapter,
        onNotification,
        onServerRequest,
        credentials,
        buildEnvironment,
        onDiagnostic,
        spawnImpl() {
          if (!child) child = fakeChild();
          return child;
        },
        job: { add() {}, async terminate() {} },
      });
    },
  });
  return { manager, approvals, child: () => child };
}

function emit(child, message) {
  child.stdout.emit('data', `${JSON.stringify(message)}\n`);
}

test('a codex approval server request waits for the operator', async () => {
  const { manager, approvals, child: childOf } = codexManager();
  const backend = await manager.get('codex-local');
  const child = childOf();
  emit(child, {
    id: 99,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'th_1', command: 'rm -rf build' },
  });
  await wait();
  assert.equal(reply(child, 99), undefined, 'an approval stays unanswered until the operator rules');
  const rows = approvals.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, 'th_1');
  assert.equal(rows[0].operation, 'item/commandExecution/requestApproval');
  await backend.replyApproval('th_1', { approved: true });
  await wait();
  const answered = reply(child, 99);
  assert.deepEqual(answered.result, { decision: 'accept' });
  assert.notDeepEqual(answered.result, {});
});

test('an older approval method also waits', async () => {
  const { manager, approvals, child: childOf } = codexManager();
  await manager.get('codex-local');
  const child = childOf();
  emit(child, {
    id: 98,
    method: 'execCommandApproval',
    params: { threadId: 'th_old', command: 'rm -rf build' },
  });
  await wait();
  assert.equal(reply(child, 98), undefined, 'an approval stays unanswered until the operator rules');
  const rows = approvals.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, 'th_old');
  assert.equal(rows[0].operation, 'execCommandApproval');
  await approvals.decide(rows[0].approvalId, 'deny');
  await wait();
  assert.deepEqual(reply(child, 98).result, { decision: 'decline' });
});

test('a non-approval server request is still answered immediately', async () => {
  const { manager, approvals, child: childOf } = codexManager();
  await manager.get('codex-local');
  const child = childOf();
  emit(child, {
    id: 50,
    method: 'item/requestUserInput',
    params: { threadId: 'th_1' },
  });
  await wait();
  assert.deepEqual(reply(child, 50).result, {});
  assert.deepEqual(approvals.list(), []);
});

test('an approval with no approval service is not granted', async () => {
  const { manager, child: childOf } = codexManager({ approvals: undefined });
  await manager.get('codex-local');
  const child = childOf();
  emit(child, {
    id: 77,
    method: 'applyPatchApproval',
    params: { threadId: 'th_2' },
  });
  await wait();
  const answered = reply(child, 77);
  assert.match(answered.error?.message ?? '', /no approval handler/);
  assert.equal(answered.result, undefined);
});

test('a reply for a different run does not approve the pending command', async () => {
  const { manager, child: childOf } = codexManager();
  const backend = await manager.get('codex-local');
  const child = childOf();
  emit(child, {
    id: 70,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'th_1', command: 'rm -rf build' },
  });
  await wait();
  await assert.rejects(
    backend.replyApproval('other-run', { approved: true }),
    /no pending approval/,
  );
  assert.equal(reply(child, 70), undefined, 'a different run id must not settle this command');
  await backend.replyApproval('th_1', { approved: true });
  await wait();
  assert.deepEqual(reply(child, 70).result, { decision: 'accept' });
});

test('replyApproval with nothing pending says so', async () => {
  const { manager, child: childOf } = codexManager();
  const backend = await manager.get('codex-local');
  const child = childOf();
  await assert.rejects(
    backend.replyApproval('missing', { approved: true }),
    /no pending approval/,
  );
  assert.equal(
    child.written.find((message) => message.result !== undefined || message.error !== undefined),
    undefined,
  );
});

test('an approval that does not offer accept is declined', async () => {
  const { manager, child: childOf } = codexManager();
  const backend = await manager.get('codex-local');
  const child = childOf();
  emit(child, {
    id: 61,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'th_3', command: 'npm test', availableDecisions: ['decline'] },
  });
  await wait();
  assert.equal(reply(child, 61), undefined);
  await backend.replyApproval('th_3', { approved: true, feedback: 'ok' });
  await wait();
  assert.deepEqual(reply(child, 61).result, { decision: 'decline' });
});
