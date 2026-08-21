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
