import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistryMethods } from '../core/capabilities/registry-methods.mjs';
import { getSecret } from '../core/capabilities/secrets.mjs';

function fakeCronKind() {
  return {
    kind: 'cron',
    label: 'Cron',
    family: 'cron',
    configFields: [{ key: 'schedule', label: 'Schedule', type: 'string', required: true }],
    validate(config) {
      const errors = [];
      if (!config?.schedule || typeof config.schedule !== 'string') {
        errors.push({ field: 'schedule', message: 'must be a non-empty string' });
      }
      return { ok: errors.length === 0, errors };
    },
    toManifestEntry: (instance) => ({ id: instance.id }),
    createHandlers: () => ({}),
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'gate-registry-methods-'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const kinds = new Map([['cron', fakeCronKind()]]);
  let instances = [];
  const getState = () => ({ kinds, instances });
  // Minimal reload: re-read gate/registry/*.json against the fixed `kinds`
  // map, mirroring loadInstances() without importing it — keeps this test
  // self-contained and independent of registry.mjs's exact behavior.
  const reload = async () => {
    const entries = await readdir(join(root, 'registry'));
    instances = [];
    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;
      const id = filename.slice(0, -'.json'.length);
      const parsed = JSON.parse(await readFile(join(root, 'registry', filename), 'utf8'));
      instances.push({ id, kind: parsed.kind, label: parsed.label ?? id, config: parsed.config ?? {} });
    }
    instances.sort((a, b) => a.id.localeCompare(b.id));
    return getState();
  };
  const methods = createRegistryMethods({ root, getState, reload });
  return { root, methods };
}

test('registry.kinds.list returns the wire-safe kind catalog', async () => {
  const { methods } = await harness();
  const kinds = await methods['registry.kinds.list']();
  assert.deepEqual(kinds, [{
    id: 'cron', label: 'Cron', family: 'cron',
    configFields: [{ key: 'schedule', label: 'Schedule', type: 'string', required: true }],
  }]);
});

test('registry.instances.create writes the file, validates, and reloads', async () => {
  const { methods, root } = await harness();
  const created = await methods['registry.instances.create']({
    id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' },
  });

  assert.deepEqual(created, { id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const onDisk = JSON.parse(await readFile(join(root, 'registry', 'standup.json'), 'utf8'));
  assert.deepEqual(onDisk, { kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
});

test('registry.instances.create rejects invalid config, naming the field, without writing a file', async () => {
  const { methods, root } = await harness();
  await assert.rejects(
    methods['registry.instances.create']({ id: 'bad', kind: 'cron', label: 'Bad', config: {} }),
    /schedule/,
  );
  await assert.rejects(readFile(join(root, 'registry', 'bad.json')));
});

test('registry.instances.create rejects an unknown kind', async () => {
  const { methods } = await harness();
  await assert.rejects(
    methods['registry.instances.create']({ id: 'x', kind: 'nonexistent', label: 'X', config: {} }),
    /unknown kind/,
  );
});

test('registry.instances.create rejects a malformed id', async () => {
  const { methods } = await harness();
  await assert.rejects(
    methods['registry.instances.create']({ id: 'Not Valid!', kind: 'cron', label: 'X', config: { schedule: '* * * * *' } }),
    /lowercase alphanumeric/,
  );
});

test('registry.instances.create rejects the reserved id "registry"', async () => {
  const { methods } = await harness();
  await assert.rejects(
    methods['registry.instances.create']({ id: 'registry', kind: 'cron', label: 'X', config: { schedule: '* * * * *' } }),
    /reserved/,
  );
});

test('registry.instances.create rejects a duplicate id', async () => {
  const { methods } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  await assert.rejects(
    methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Again', config: { schedule: '0 9 * * 1-5' } }),
    /already exists/,
  );
});

test('registry.instances.list reflects what was created', async () => {
  const { methods } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const list = await methods['registry.instances.list']();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'standup');
});

test('registry.instances.get returns a single instance', async () => {
  const { methods } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const instance = await methods['registry.instances.get']({ id: 'standup' });
  assert.equal(instance.label, 'Standup');
});

test('registry.instances.get throws for an unknown id', async () => {
  const { methods } = await harness();
  await assert.rejects(methods['registry.instances.get']({ id: 'nope' }), /not found/);
});

test('registry.instances.update rewrites the file and re-validates', async () => {
  const { methods, root } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const updated = await methods['registry.instances.update']({
    id: 'standup', label: 'Standup (updated)', config: { schedule: '0 10 * * 1-5' },
  });

  assert.equal(updated.label, 'Standup (updated)');
  assert.deepEqual(updated.config, { schedule: '0 10 * * 1-5' });
  const onDisk = JSON.parse(await readFile(join(root, 'registry', 'standup.json'), 'utf8'));
  assert.equal(onDisk.config.schedule, '0 10 * * 1-5');
});

test('registry.instances.update rejects invalid config and leaves the file unchanged', async () => {
  const { methods, root } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  await assert.rejects(methods['registry.instances.update']({ id: 'standup', config: {} }), /schedule/);
  const onDisk = JSON.parse(await readFile(join(root, 'registry', 'standup.json'), 'utf8'));
  assert.equal(onDisk.config.schedule, '0 9 * * 1-5');
});

test('registry.instances.update throws for an unknown id', async () => {
  const { methods } = await harness();
  await assert.rejects(methods['registry.instances.update']({ id: 'nope', config: {} }), /not found/);
});

test('registry.instances.delete removes the file and the instance', async () => {
  const { methods, root } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const result = await methods['registry.instances.delete']({ id: 'standup' });

  assert.deepEqual(result, { deleted: true });
  await assert.rejects(readFile(join(root, 'registry', 'standup.json')));
  assert.deepEqual(await methods['registry.instances.list'](), []);
});

test('registry.instances.delete throws for an unknown id', async () => {
  const { methods } = await harness();
  await assert.rejects(methods['registry.instances.delete']({ id: 'nope' }), /not found/);
});

test('registry.secrets.set stores a value retrievable via getSecret, never returned by the method itself', async () => {
  const { methods, root } = await harness();
  const result = await methods['registry.secrets.set']({ refName: 'MY_API_KEY', value: 'sk-live-abc' });

  assert.deepEqual(result, { ok: true });
  assert.equal(await getSecret(root, 'MY_API_KEY'), 'sk-live-abc');
});

test('registry.secrets.set rejects an empty refName or value', async () => {
  const { methods } = await harness();
  await assert.rejects(methods['registry.secrets.set']({ refName: '', value: 'x' }), /refName/);
  await assert.rejects(methods['registry.secrets.set']({ refName: 'X', value: '' }), /value/);
});
