import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInstanceHandlers } from '../core/capabilities/dispatch.mjs';

function fakeKinds() {
  const kinds = new Map();
  kinds.set('cron', {
    kind: 'cron',
    label: 'Cron',
    family: 'cron',
    configFields: [],
    validate: () => ({ ok: true, errors: [] }),
    toManifestEntry: (instance) => ({ id: instance.id }),
    createHandlers: (instance) => ({
      run: async () => ({ ranInstance: instance.id }),
      history: async () => [],
    }),
  });
  return kinds;
}

test('prefixes each handler with the instance id', () => {
  const kinds = fakeKinds();
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: {} }];
  const table = buildInstanceHandlers(kinds, instances);

  assert.ok(table.has('standup.run'));
  assert.ok(table.has('standup.history'));
  assert.equal(table.has('run'), false);
});

test('two instances of the same kind never collide', async () => {
  const kinds = fakeKinds();
  const instances = [
    { id: 'standup', kind: 'cron', label: 'Standup', config: {} },
    { id: 'weekly-report', kind: 'cron', label: 'Weekly report', config: {} },
  ];
  const table = buildInstanceHandlers(kinds, instances);

  assert.equal(table.size, 4);
  const result = await table.get('standup.run')();
  assert.deepEqual(result, { ranInstance: 'standup' });
});

test('isolates a kind whose createHandlers() throws, without losing other instances', () => {
  const kinds = fakeKinds();
  kinds.set('broken', {
    kind: 'broken', label: 'Broken', family: 'broken', configFields: [],
    validate: () => ({ ok: true, errors: [] }),
    toManifestEntry: () => ({}),
    createHandlers: () => { throw new Error('boom'); },
  });
  const instances = [
    { id: 'standup', kind: 'cron', label: 'Standup', config: {} },
    { id: 'oops', kind: 'broken', label: 'Oops', config: {} },
  ];
  const table = buildInstanceHandlers(kinds, instances);

  assert.ok(table.has('standup.run'));
  assert.equal(table.has('oops.run'), false);
  assert.equal(table.size, 2);
});

test('an instance whose kind contributes no handlers adds nothing to the table', () => {
  const kinds = fakeKinds();
  kinds.set('provider', {
    kind: 'provider', label: 'Provider', family: 'provider', configFields: [],
    validate: () => ({ ok: true, errors: [] }),
    toManifestEntry: () => ({}),
    createHandlers: () => ({}),
  });
  const instances = [{ id: 'nvidia', kind: 'provider', label: 'NVIDIA', config: {} }];
  const table = buildInstanceHandlers(kinds, instances);

  assert.equal(table.size, 0);
});
