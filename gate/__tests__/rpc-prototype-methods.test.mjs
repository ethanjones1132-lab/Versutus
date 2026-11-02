import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

// The RPC dispatcher used to resolve a method with
//   registryMethods[rpcMethod] ?? gatewayMethods[rpcMethod] ?? state.dispatch.get(rpcMethod)
// Both method tables are object literals, so the bracket lookup walked
// Object.prototype. A caller asking for "constructor" got Object's constructor
// back as if the Gate had registered it, and it answered 200 with the params
// echoed as the result; "toString" and "__proto__" resolved to inherited
// members too and answered 400 as though a real handler had thrown. Only own
// properties are dispatchable: every other name gets the same 404
// unknown_method answer a made-up name has always received, and the genuinely
// registered methods dispatch exactly as before.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-rpc-prototype-'));
  roots.push(root);
  await mkdir(join(root, 'core', 'capabilities', 'cron'), { recursive: true });
  await writeFile(
    join(root, 'core', 'capabilities', 'cron', 'kind.mjs'),
    `
export default {
  kind: 'cron',
  label: 'Cron',
  family: 'cron',
  configFields: [{ key: 'schedule', label: 'Schedule', type: 'string', required: true }],
  validate(config) {
    const errors = [];
    if (!config?.schedule) errors.push({ field: 'schedule', message: 'is required' });
    return { ok: errors.length === 0, errors };
  },
  toManifestEntry(instance) { return { id: instance.id, schedule: instance.config.schedule }; },
  createHandlers(instance) {
    return { run: async () => ({ ranInstance: instance.id }) };
  },
};
`,
    'utf8',
  );
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(
    join(root, 'registry', 'standup.json'),
    JSON.stringify({ kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } }),
    'utf8',
  );
  return createGate({ root, port: 0 });
}

function rpc(gate, method, params) {
  return fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify(params === undefined ? { method } : { method, params }),
  });
}

/** Names every one of these literals inherits through Object.prototype. */
const INHERITED_NAMES = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
  '__defineGetter__',
];

test('Object.prototype members are not dispatchable RPC methods', async () => {
  const gate = await makeGate();
  try {
    for (const method of INHERITED_NAMES) {
      const response = await rpc(gate, method);
      // Before the fix: "constructor" and friends answered 200 with the params
      // echoed as the result, while "toString"/"__proto__" answered 400 as a
      // thrown handler would.
      assert.equal(response.status, 404, `${method} must not resolve to an inherited member`);
      const body = await response.json();
      assert.equal(body.error.code, 'unknown_method', `${method} must be an unknown method`);
      assert.equal(body.error.message, `Unknown method "${method}"`);
    }
  } finally {
    await gate.close();
  }
});

test('an inherited name cannot be smuggled in as a callable that echoes its params', async () => {
  const gate = await makeGate();
  try {
    // "constructor" was the worst case: Object(params) is a function, so the
    // dispatcher called it and serialized the params object as a 200 result.
    const response = await rpc(gate, 'constructor', { payload: 'should never come back' });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.result, undefined);
    assert.doesNotMatch(JSON.stringify(body), /should never come back/);
  } finally {
    await gate.close();
  }
});

test('a registered registry method still dispatches as before', async () => {
  const gate = await makeGate();
  try {
    const response = await rpc(gate, 'registry.kinds.list');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.map((kind) => kind.id), ['cron']);
  } finally {
    await gate.close();
  }
});

test('a registered gateway method still dispatches as before', async () => {
  const gate = await makeGate();
  try {
    const response = await rpc(gate, 'health');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.status, 'ok');
    assert.equal(typeof body.result.timestamp, 'string');
  } finally {
    await gate.close();
  }
});

test('an instance-contributed method still dispatches through the dispatch map', async () => {
  const gate = await makeGate();
  try {
    const response = await rpc(gate, 'standup.run');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result, { ranInstance: 'standup' });
  } finally {
    await gate.close();
  }
});

test('a name nobody registered keeps the existing unknown-method answer', async () => {
  const gate = await makeGate();
  try {
    const response = await rpc(gate, 'nonexistent.method');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { message: 'Unknown method "nonexistent.method"', code: 'unknown_method' },
    });
  } finally {
    await gate.close();
  }
});
