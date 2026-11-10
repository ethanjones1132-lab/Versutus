import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';
import { ApprovalService } from '../core/cli-environments/approvals.mjs';

/**
 * The manager, not the adapter, owns the bridge: it is the thing that knows
 * whether an inbox exists, and it is the thing that stops an environment. A
 * Claude Code environment with approvals must get exactly one listener however
 * many turns ask at once, and it must not outlive that environment.
 */

function claudeRecord(id = 'claude-local') {
  return {
    id,
    enabled: true,
    adapterId: 'claude-code',
    executable: { path: 'claude.exe' },
    workspacePolicy: { defaultRoot: 'C:\\ws' },
  };
}

/** An adapter that records the options the manager built it with. */
function stubAdapter(adapterId, seen) {
  return {
    adapterId,
    server: { transport: 'per-turn' },
    createBackend(options) {
      seen.push(options);
      return { kind: adapterId };
    },
  };
}

function managerWith({ records, adapters, approvals }) {
  const byId = new Map(records.map((record) => [record.id, record]));
  return createBackendManager({
    store: { async get(id) { return byId.get(id) ?? null; } },
    registry: { get: (id) => adapters[id] },
    ...(approvals ? { approvals } : {}),
  });
}

/** A GET against the bridge's port: 404 means something is listening. */
async function listening(url) {
  try {
    await fetch(url, { method: 'GET' });
    return true;
  } catch {
    return false;
  }
}

test('concurrent turns on one claude-code environment share one bridge, closed when it stops', async () => {
  const seen = [];
  const manager = managerWith({
    records: [claudeRecord()],
    adapters: { 'claude-code': stubAdapter('claude-code', seen) },
    approvals: new ApprovalService(),
  });

  const [first, second] = await Promise.all([manager.get('claude-local'), manager.get('claude-local')]);
  assert.equal(first.kind, 'claude-code');
  assert.equal(second.kind, 'claude-code');

  // A third turn is served by the cached backend: no bridge and no factory call.
  await manager.get('claude-local');
  assert.equal(seen.length, 2, 'the per-turn backend stays cached');

  assert.equal(seen.length, 2, 'both concurrent callers built a backend');
  const bridge = seen[0].permissionBridge;
  assert.ok(bridge, 'an environment with an inbox gets a bridge');
  assert.equal(seen[1].permissionBridge, bridge, 'the in-flight bridge is shared, not raced');
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/permission$/);
  assert.equal(typeof bridge.secret, 'string');
  assert.ok(bridge.secret.length >= 16);

  assert.equal(await listening(bridge.url), true, 'the bridge is accepting before the turn uses it');

  await manager.stopAll();

  assert.equal(await listening(bridge.url), false, 'stopping the manager must not leak the listener');
});

test('without approvals a claude-code turn is built with no bridge', async () => {
  const seen = [];
  const manager = managerWith({
    records: [claudeRecord()],
    adapters: { 'claude-code': stubAdapter('claude-code', seen) },
  });

  await manager.get('claude-local');
  await manager.stopAll();

  assert.equal(seen.length, 1);
  assert.equal('permissionBridge' in seen[0], false);
});

test('another per-turn adapter is never given a bridge, even with approvals', async () => {
  const seen = [];
  const manager = managerWith({
    records: [{ ...claudeRecord('other-local'), adapterId: 'other' }],
    adapters: { other: stubAdapter('other', seen) },
    approvals: new ApprovalService(),
  });

  await manager.get('other-local');
  await manager.stopAll();

  assert.equal(seen.length, 1);
  assert.equal('permissionBridge' in seen[0], false);
});
