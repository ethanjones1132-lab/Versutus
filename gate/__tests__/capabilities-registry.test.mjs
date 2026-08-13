import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadKinds, loadInstances, describeKinds, resolveManifestInstances, loadCapabilities } from '../core/capabilities/registry.mjs';

async function kindsDir(entries) {
  const root = await mkdtemp(join(tmpdir(), 'gate-kinds-'));
  for (const [id, source] of Object.entries(entries)) {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, 'kind.mjs'), source, 'utf8');
  }
  return root;
}

const goodKind = (id) => `
export default {
  kind: '${id}',
  label: '${id}',
  family: '${id}',
  configFields: [],
  validate(config) { return { ok: true, errors: [] }; },
  toManifestEntry(instance) { return { id: instance.id }; },
  createHandlers(instance) { return {}; },
};
`;

test('loads a valid kind', async () => {
  const root = await kindsDir({ cron: goodKind('cron') });
  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 1);
  assert.equal(kinds.get('cron').label, 'cron');
  assert.deepEqual(skipped, []);
});

test('skips a kind that throws on import, without losing the others', async () => {
  const root = await kindsDir({
    cron: goodKind('cron'),
    exploding: `throw new Error('boom');`,
  });

  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 1);
  assert.ok(kinds.has('cron'));
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'exploding');
  assert.match(skipped[0].reason, /boom/);
});

test('skips a kind missing a required export', async () => {
  const root = await kindsDir({
    broken: `export default { kind: 'broken', label: 'Broken' };`,
  });

  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /missing/);
});

test('returns empty rather than throwing when there are no kinds', async () => {
  const root = await kindsDir({});
  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 0);
  assert.deepEqual(skipped, []);
});

function fakeKinds(overrides = {}) {
  const kinds = new Map();
  kinds.set('cron', {
    kind: 'cron',
    label: 'Cron',
    family: 'cron',
    configFields: [],
    validate: overrides.validate ?? (() => ({ ok: true, errors: [] })),
    toManifestEntry: overrides.toManifestEntry ?? ((instance) => ({ id: instance.id })),
    createHandlers: () => ({}),
  });
  return kinds;
}

async function registryDir(entries) {
  const root = await mkdtemp(join(tmpdir(), 'gate-registry-'));
  for (const [filename, contents] of Object.entries(entries)) {
    await writeFile(join(root, filename), typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  }
  return root;
}

test('loads a valid instance referencing a known kind', async () => {
  const root = await registryDir({
    'standup.json': { kind: 'cron', label: 'Standup reminder', config: { schedule: '0 9 * * 1-5' } },
  });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0], {
    id: 'standup',
    kind: 'cron',
    label: 'Standup reminder',
    config: { schedule: '0 9 * * 1-5' },
  });
  assert.deepEqual(skipped, []);
});

test('skips an instance referencing an unknown kind', async () => {
  const root = await registryDir({
    'ghost.json': { kind: 'nonexistent', label: 'Ghost', config: {} },
  });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /unknown kind/);
});

test('skips an instance that fails its kind\'s validate()', async () => {
  const root = await registryDir({
    'bad.json': { kind: 'cron', label: 'Bad', config: {} },
  });
  const kinds = fakeKinds({ validate: () => ({ ok: false, errors: [{ field: 'schedule', message: 'is required' }] }) });
  const { instances, skipped } = await loadInstances(root, kinds);

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /schedule: is required/);
});

test('skips malformed JSON without crashing', async () => {
  const root = await registryDir({ 'broken.json': '{ not valid json' });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /invalid JSON/);
});

test('rejects the reserved instance id "registry"', async () => {
  const root = await registryDir({
    'registry.json': { kind: 'cron', label: 'Should not load', config: {} },
  });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'registry');
  assert.match(skipped[0].reason, /reserved/);
});

test('ignores non-.json files in the registry directory', async () => {
  const root = await registryDir({ 'readme.md': '# not an instance' });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.deepEqual(instances, []);
  assert.deepEqual(skipped, []);
});

test('returns instances sorted by id', async () => {
  const root = await registryDir({
    'zzz.json': { kind: 'cron', label: 'Z', config: {} },
    'aaa.json': { kind: 'cron', label: 'A', config: {} },
  });
  const { instances } = await loadInstances(root, fakeKinds());

  assert.deepEqual(instances.map((i) => i.id), ['aaa', 'zzz']);
});

test('describeKinds exposes only the wire-safe kind fields', () => {
  const kinds = fakeKinds();
  const described = describeKinds(kinds);

  assert.deepEqual(described, [
    { id: 'cron', label: 'Cron', family: 'cron', configFields: [] },
  ]);
});

test('resolveManifestInstances attaches family and calls toManifestEntry', () => {
  const kinds = fakeKinds();
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } }];

  const resolved = resolveManifestInstances(kinds, instances);

  assert.deepEqual(resolved, [
    { id: 'standup', kind: 'cron', label: 'Standup', family: 'cron', manifestEntry: { id: 'standup' } },
  ]);
});

test('loadKinds gracefully handles a nonexistent directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-kinds-'));
  const nonexistentPath = join(root, 'does-not-exist');

  const { kinds, skipped } = await loadKinds(nonexistentPath);

  assert.equal(kinds.size, 0);
  assert.deepEqual(skipped, []);
});

test('loadInstances gracefully handles a nonexistent directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-registry-'));
  const nonexistentPath = join(root, 'does-not-exist');

  const { instances, skipped } = await loadInstances(nonexistentPath, fakeKinds());

  assert.equal(instances.length, 0);
  assert.deepEqual(skipped, []);
});

test('loadCapabilities loads kinds and instances together', async () => {
  const gateRoot = await mkdtemp(join(tmpdir(), 'gate-root-'));

  // Create a kind
  const kindDir = join(gateRoot, 'core', 'capabilities', 'cron');
  await mkdir(kindDir, { recursive: true });
  await writeFile(join(kindDir, 'kind.mjs'), goodKind('cron'), 'utf8');

  // Create an instance
  const registryDir = join(gateRoot, 'registry');
  await mkdir(registryDir, { recursive: true });
  await writeFile(join(registryDir, 'standup.json'), JSON.stringify({
    kind: 'cron',
    label: 'Standup reminder',
    config: { schedule: '0 9 * * 1-5' },
  }), 'utf8');

  const { kinds, instances, skippedKinds, skippedInstances } = await loadCapabilities(gateRoot);

  assert.equal(kinds.size, 1);
  assert.ok(kinds.has('cron'));
  assert.deepEqual(skippedKinds, []);

  assert.equal(instances.length, 1);
  assert.equal(instances[0].id, 'standup');
  assert.deepEqual(skippedInstances, []);
});

test('skips an instance when its kind\'s validate() throws', async () => {
  const root = await registryDir({
    'bad.json': { kind: 'cron', label: 'Bad', config: {} },
  });
  const kinds = fakeKinds({ validate: () => { throw new Error('boom'); } });
  const { instances, skipped } = await loadInstances(root, kinds);

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'bad');
  assert.match(skipped[0].reason, /validate\(\) threw: boom/);
});

test('resolveManifestInstances silently excludes instances whose kind\'s toManifestEntry() throws', () => {
  const kinds = fakeKinds({ toManifestEntry: () => { throw new Error('boom'); } });
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } }];

  const resolved = resolveManifestInstances(kinds, instances);

  assert.equal(resolved.length, 0);
});

test('resolveManifestInstances qualifies a kind\'s declared command methods with the instance id', () => {
  const kinds = fakeKinds();
  kinds.get('cron').commands = [
    { slash: '/standup', description: 'Run it', method: 'run', danger: 'write' },
  ];
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: {} }];

  const [resolved] = resolveManifestInstances(kinds, instances);

  // 'run' is the local handler name the kind declares; buildInstanceHandlers
  // registers it as 'standup.run', so that is what the app must be told.
  assert.deepEqual(resolved.commands, [
    { slash: '/standup', description: 'Run it', method: 'standup.run', danger: 'write' },
  ]);
});

test('two instances of one kind get distinctly qualified command methods', () => {
  const kinds = fakeKinds();
  kinds.get('cron').commands = [
    { slash: '/run', description: 'Run it', method: 'run', danger: 'write' },
  ];
  const instances = [
    { id: 'standup', kind: 'cron', label: 'Standup', config: {} },
    { id: 'weekly', kind: 'cron', label: 'Weekly', config: {} },
  ];

  const resolved = resolveManifestInstances(kinds, instances);

  assert.equal(resolved[0].commands[0].method, 'standup.run');
  assert.equal(resolved[1].commands[0].method, 'weekly.run');
});

test('resolveManifestInstances preserves a command\'s other declared fields', () => {
  const kinds = fakeKinds();
  kinds.get('cron').commands = [
    { slash: '/standup', description: 'Run it', method: 'run', danger: 'write', params: { dryRun: true } },
  ];
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: {} }];

  const [resolved] = resolveManifestInstances(kinds, instances);

  assert.deepEqual(resolved.commands[0].params, { dryRun: true });
  assert.equal(resolved.commands[0].danger, 'write');
});

test('resolveManifestInstances does not mutate the kind\'s own command declarations', () => {
  const kinds = fakeKinds();
  kinds.get('cron').commands = [
    { slash: '/run', description: 'Run it', method: 'run', danger: 'write' },
  ];
  const instances = [
    { id: 'standup', kind: 'cron', label: 'Standup', config: {} },
    { id: 'weekly', kind: 'cron', label: 'Weekly', config: {} },
  ];

  resolveManifestInstances(kinds, instances);

  // The kind is a shared, long-lived module object — qualifying in place would
  // make the second instance inherit the first's prefix on a later reload.
  assert.equal(kinds.get('cron').commands[0].method, 'run');
});

test('resolveManifestInstances omits commands for a kind that declares none', () => {
  const kinds = fakeKinds();
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: {} }];

  const [resolved] = resolveManifestInstances(kinds, instances);

  assert.equal(resolved.commands, undefined);
});
