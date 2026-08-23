import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBotGroupStore, planGroupRounds, validateGroup } from '../core/cli-environments/bot-groups.mjs';

test('validateGroup enforces 2–6 members', () => {
  assert.equal(validateGroup({ name: 'crew', memberIds: ['a'] }).ok, false);
  assert.equal(validateGroup({ name: 'crew', memberIds: ['a', 'b'] }).ok, true);
});

test('store round-trips a group', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['coder', 'researcher'] });
  assert.equal(created.name, 'crew');
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal((await store.get(created.id)).id, created.id);
});

test('planGroupRounds caps work', () => {
  const planned = planGroupRounds({ memberIds: ['a', 'b'], mentionedIds: ['a'] });
  assert.ok(planned.every((step) => step.botId === 'a'));
  assert.ok(planned.length <= 10);
});

test('rename persists a trimmed name and refuses blank or unknown ids', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['coder', 'researcher'] });

  const renamed = await store.rename(created.id, '  bridge crew  ');
  assert.equal(renamed.name, 'bridge crew');
  assert.equal((await store.get(created.id)).name, 'bridge crew');

  await assert.rejects(store.rename(created.id, '   '), (error) => {
    assert.equal(error.code, 'invalid_group');
    assert.equal(error.status, 400);
    return true;
  });

  await assert.rejects(store.rename('missing', 'x'), (error) => {
    assert.equal(error.code, 'unknown_group');
    assert.equal(error.status, 404);
    return true;
  });
});

test('leave removes a member but keeps rooms viable at two', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['a', 'b', 'c'] });

  const left = await store.leave(created.id, 'a');
  assert.deepEqual(left.memberIds, ['b', 'c']);

  // At the floor the room would stop being a room — refuse instead.
  await assert.rejects(store.leave(created.id, 'b'), (error) => {
    assert.equal(error.code, 'too_few_members');
    assert.equal(error.status, 400);
    return true;
  });
  assert.deepEqual((await store.get(created.id)).memberIds, ['b', 'c']);

  await assert.rejects(store.leave(created.id, 'stranger'), (error) => {
    assert.equal(error.code, 'unknown_member');
    return true;
  });
  await assert.rejects(store.leave('missing', 'b'), (error) => {
    assert.equal(error.code, 'unknown_group');
    return true;
  });
});
