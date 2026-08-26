import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBotGroupStore, MAX_GROUP_HISTORY, planGroupRounds, transcriptEntriesForSend, validateGroup } from '../core/cli-environments/bot-groups.mjs';

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

test('leave evicts a roster-dead member even at the two-member floor', async () => {
  // A pre-door-check room carrying a dead id: the door refuses such a create
  // today, which is exactly why legacy rows were stranded — add refused
  // unknown_member for the whole room, leave refused too_few_members at the
  // floor, and disband (transcript deleted) was the only exit.
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  await writeFile(
    join(home, 'bot-groups.json'),
    JSON.stringify({
      groups: [{ id: 'legacy', name: 'legacy crew', memberIds: ['coder', 'ghost'] }],
      transcripts: { legacy: [{ botId: 'coder', text: 'earlier reply', at: 1 }] },
    }),
    'utf8',
  );
  const store = createBotGroupStore(home, { listBotIds: async () => ['coder', 'researcher'] });

  const left = await store.leave('legacy', 'ghost');
  assert.deepEqual(left.memberIds, ['coder']);
  // Eviction keeps the transcript — that is the entire point over disband.
  assert.equal((await store.history('legacy')).length, 1);
});

test('leave still refuses a live member at the floor and names disband', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home, { listBotIds: async () => ['coder', 'researcher'] });
  const created = await store.create({ name: 'crew', memberIds: ['coder', 'researcher'] });

  await assert.rejects(store.leave(created.id, 'researcher'), (error) => {
    assert.equal(error.code, 'too_few_members');
    assert.match(error.message, /disband/i);
    return true;
  });
});

test('leave falls back to the plain floor when the roster cannot be read', async () => {
  // No resolver answer means nobody can be proven dead, so nobody is exempt:
  // leaving never becomes harder than before, and never easier on a guess.
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  await writeFile(
    join(home, 'bot-groups.json'),
    JSON.stringify({
      groups: [{ id: 'legacy', name: 'legacy crew', memberIds: ['coder', 'ghost'] }],
      transcripts: {},
    }),
    'utf8',
  );
  const store = createBotGroupStore(home, {
    listBotIds: async () => {
      throw new Error('roster down');
    },
  });

  await assert.rejects(store.leave('legacy', 'ghost'), (error) => {
    assert.equal(error.code, 'too_few_members');
    return true;
  });
});

test('transcriptEntriesForSend records the operator line plus each reply in order', () => {
  let seq = 0;
  const entries = transcriptEntriesForSend({
    text: 'plan the launch',
    replies: [
      { botId: 'coder', text: 'on it' },
      { botId: 'researcher', text: 'drafting' },
    ],
    makeId: () => `id-${(seq += 1)}`,
    now: 1234,
  });
  assert.deepEqual(entries, [
    { id: 'id-1', role: 'user', text: 'plan the launch', at: 1234 },
    { id: 'id-2', role: 'bot', botId: 'coder', text: 'on it', at: 1234 },
    { id: 'id-3', role: 'bot', botId: 'researcher', text: 'drafting', at: 1234 },
  ]);

  // A silent round still keeps the user's line — "nobody answered" is history.
  const silent = transcriptEntriesForSend({ text: 'anyone there?', replies: [], makeId: () => 'x', now: 9 });
  assert.deepEqual(silent, [{ id: 'x', role: 'user', text: 'anyone there?', at: 9 }]);
});

test('store transcripts append, replay oldest-first, and cap at MAX_GROUP_HISTORY', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['coder', 'researcher'] });

  // Empty appends are a no-op, not an error.
  assert.equal(await store.appendMessages(created.id, []), 0);

  let seq = 0;
  const nextId = () => `t${(seq += 1)}`;
  await store.appendMessages(created.id, transcriptEntriesForSend({
    text: 'first',
    replies: [{ botId: 'coder', text: 'hello' }],
    makeId: nextId,
    now: 1,
  }));
  await store.appendMessages(created.id, transcriptEntriesForSend({
    text: 'second',
    replies: [],
    makeId: nextId,
    now: 2,
  }));

  const history = await store.history(created.id);
  // Oldest-first: the operator's line, then each reply of that send.
  assert.deepEqual(history.map((entry) => entry.id), ['t1', 't2', 't3']);
  assert.deepEqual(history[0], { id: 't1', role: 'user', text: 'first', at: 1 });
  assert.deepEqual(history[1], { id: 't2', role: 'bot', botId: 'coder', text: 'hello', at: 1 });
  assert.deepEqual(history[2], { id: 't3', role: 'user', text: 'second', at: 2 });

  // A brand-new room starts with an empty transcript, not an error.
  const fresh = await store.create({ name: 'next', memberIds: ['a', 'b'] });
  assert.deepEqual(await store.history(fresh.id), []);

  await assert.rejects(store.history('missing'), (error) => {
    assert.equal(error.code, 'unknown_group');
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(store.appendMessages('missing', [{ id: 'x', role: 'user', text: 'y' }]), (error) => {
    assert.equal(error.code, 'unknown_group');
    return true;
  });

  // The cap keeps the NEWEST entries — old lines fall off the front.
  for (let round = 0; round < MAX_GROUP_HISTORY; round += 1) {
    await store.appendMessages(created.id, [{ id: `bulk-${round}`, role: 'user', text: String(round), at: round }]);
  }
  const capped = await store.history(created.id);
  assert.equal(capped.length, MAX_GROUP_HISTORY);
  assert.ok(!capped.some((entry) => entry.id === 't1'), 'oldest lines drop off');
  assert.equal(capped[capped.length - 1].id, `bulk-${MAX_GROUP_HISTORY - 1}`);
});

test('verifyMembers re-checks the live roster at the send door', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  let roster = ['coder', 'researcher'];
  const store = createBotGroupStore(home, { listBotIds: async () => roster });
  const created = await store.create({ name: 'crew', memberIds: ['coder', 'researcher'] });

  // Environment reorder between create and first send: the roster no longer
  // answers to one of the room's members (a profile renamed or removed on
  // the host). The create-time door check already ran and cannot see this —
  // only the live re-check at the send door can, and it refuses with the
  // membership verdict, naming the dead member.
  roster = roster.filter((id) => id !== 'researcher');
  await assert.rejects(store.verifyMembers(created.memberIds), (error) => {
    assert.equal(error.code, 'unknown_member');
    assert.equal(error.status, 400);
    assert.match(error.message, /researcher/);
    return true;
  });

  // Members the live roster still answers to pass.
  await store.verifyMembers(['coder']);

  // Without a resolver nothing is claimed: verification only runs when the
  // Gate actually wired one.
  const bare = createBotGroupStore(home);
  await bare.verifyMembers(['coder']);
});
