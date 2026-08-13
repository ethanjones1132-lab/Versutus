import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

async function gateWithCronKind() {
  const root = await mkdtemp(join(tmpdir(), 'gate-rpc-'));
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

test('rejects an unauthenticated rpc request', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'registry.kinds.list' }),
    });
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});

test('dispatches to a built-in registry method', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'registry.instances.list' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.length, 1);
    assert.equal(body.result[0].id, 'standup');
  } finally {
    await gate.close();
  }
});

test('dispatches to an instance-contributed method', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'standup.run' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result, { ranInstance: 'standup' });
  } finally {
    await gate.close();
  }
});

test('dispatches rpc remounted under a provider child prefix', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/nvidia/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'standup.run' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result, { ranInstance: 'standup' });
  } finally {
    await gate.close();
  }
});

test('returns 404 for an unknown method', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'nonexistent.method' }),
    });
    assert.equal(response.status, 404);
  } finally {
    await gate.close();
  }
});

test('a handler that throws returns a 400 with the error message, not a 500', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'registry.instances.get', params: { id: 'nope' } }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error.message, /not found/);
  } finally {
    await gate.close();
  }
});

test('creating a new instance via rpc makes it immediately dispatchable, no restart', async () => {
  const gate = await gateWithCronKind();
  try {
    const createResponse = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        method: 'registry.instances.create',
        params: { id: 'weekly-report', kind: 'cron', label: 'Weekly report', config: { schedule: '0 9 * * 1' } },
      }),
    });
    assert.equal(createResponse.status, 200);

    const runResponse = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'weekly-report.run' }),
    });
    assert.equal(runResponse.status, 200);
    const body = await runResponse.json();
    assert.deepEqual(body.result, { ranInstance: 'weekly-report' });
  } finally {
    await gate.close();
  }
});

test('the manifest reflects a created instance without restarting the gate', async () => {
  const gate = await gateWithCronKind();
  try {
    await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        method: 'registry.instances.create',
        params: { id: 'weekly-report', kind: 'cron', label: 'Weekly report', config: { schedule: '0 9 * * 1' } },
      }),
    });
    const manifestResponse = await fetch(`http://localhost:${gate.port}/.well-known/gateway.json`);
    const manifest = await manifestResponse.json();
    assert.ok(manifest.capabilityInstances.map((i) => i.id).includes('weekly-report'));
  } finally {
    await gate.close();
  }
});
