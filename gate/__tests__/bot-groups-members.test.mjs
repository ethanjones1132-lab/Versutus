import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBotGroupStore, transcriptEntriesForSend } from '../core/cli-environments/bot-groups.mjs';

test('addMembers appends new members, persists them, and leaves the transcript alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['coder', 'researcher'] });
  await store.appendMessages(created.id, transcriptEntriesForSend({ text: 'hello room', replies: [] }));

  const updated = await store.addMembers(created.id, ['reviewer']);
  assert.deepEqual(updated.memberIds, ['coder', 'researcher', 'reviewer']);
  assert.equal((await store.get(created.id)).memberIds.length, 3);

  // Adding a member must not touch the stored conversation — the room's
  // history belongs to the members it had when the lines were spoken.
  const disk = JSON.parse(await readFile(join(home, 'bot-groups.json'), 'utf8'));
  assert.equal(disk.transcripts[created.id].length, 1);
  assert.deepEqual((await store.history(created.id)).map((entry) => entry.text), ['hello room']);
});

test('addMembers dedupes the request and skips members already in the room', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['a', 'b'] });

  const updated = await store.addMembers(created.id, ['c', 'c', 'a', 'c']);
  assert.deepEqual(updated.memberIds, ['a', 'b', 'c']);
});

test('addMembers refuses an add that names nothing new', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['a', 'b'] });

  await assert.rejects(store.addMembers(created.id, ['b', 'b']), (error) => {
    assert.equal(error.code, 'no_new_members');
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(store.addMembers(created.id, []), (error) => {
    assert.equal(error.code, 'no_new_members');
    return true;
  });
  // The refused add wrote nothing.
  assert.deepEqual((await store.get(created.id)).memberIds, ['a', 'b']);
});

test('addMembers holds the six-member ceiling', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({
    name: 'full house',
    memberIds: ['a', 'b', 'c', 'd'],
  });
  await store.addMembers(created.id, ['e']);

  await assert.rejects(store.addMembers(created.id, ['f', 'g']), (error) => {
    assert.equal(error.code, 'too_many_members');
    assert.equal(error.status, 400);
    return true;
  });
  assert.deepEqual((await store.get(created.id)).memberIds, ['a', 'b', 'c', 'd', 'e']);
});

test('addMembers refuses unknown rooms and malformed ids', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);

  await assert.rejects(store.addMembers('missing', ['a']), (error) => {
    assert.equal(error.code, 'unknown_group');
    assert.equal(error.status, 404);
    return true;
  });

  const created = await store.create({ name: 'crew', memberIds: ['a', 'b'] });
  await assert.rejects(store.addMembers(created.id, ['a', 42]), (error) => {
    assert.equal(error.code, 'invalid_group');
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(store.addMembers(created.id, ['a', '   ']), (error) => {
    assert.equal(error.code, 'invalid_group');
    return true;
  });
  assert.deepEqual((await store.get(created.id)).memberIds, ['a', 'b']);
});

test('concurrent adds both land through the mutation queue', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['anchor1x', 'b'] });

  await Promise.all([
    store.addMembers(created.id, ['c']),
    store.addMembers(created.id, ['d']),
  ]);
  // Each caller's return value reflects the room as of its own completion,
  // so the durable truth is what the next read sees: both additions landed,
  // neither clobbered the other.
  const final = await store.get(created.id);
  assert.deepEqual([...final.memberIds].sort(), ['anchor1x', 'b', 'c', 'd']);
});

test('create refuses members the wired roster does not know, persisting nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home, { listBotIds: async () => ['a', 'b'] });

  await assert.rejects(store.create({ name: 'crew', memberIds: ['a', 'ghost'] }), (error) => {
    assert.equal(error.code, 'unknown_member');
    assert.equal(error.status, 400);
    assert.match(error.message, /ghost/);
    return true;
  });
  // The refused create wrote nothing: no doomed room lingers on disk waiting
  // to 404 on its first message.
  const disk = await readFile(join(home, 'bot-groups.json'), 'utf8').catch(() => null);
  assert.equal(disk, null, 'the refused create must not persist a room');
});

test('an unreachable roster refuses membership writes honestly instead of guessing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home, {
    listBotIds: async () => {
      throw new Error('hermes down');
    },
  });

  await assert.rejects(store.create({ name: 'crew', memberIds: ['a', 'b'] }), (error) => {
    assert.equal(error.code, 'roster_unavailable');
    assert.equal(error.status, 502);
    assert.match(error.message, /hermes down/);
    return true;
  });
});

test('a roster-resolved room still creates and adds when every id verifies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home, { listBotIds: async () => ['a', 'b', 'c'] });
  const created = await store.create({ name: 'crew', memberIds: ['a', 'b'] });
  const updated = await store.addMembers(created.id, ['c']);
  assert.deepEqual(updated.memberIds, ['a', 'b', 'c']);
});

test('adds keep the WHOLE room addressable, exposing a legacy dead member', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  // A room from before the roster guard existed carries a dead id.
  const unverified = createBotGroupStore(home);
  const legacy = await unverified.create({ name: 'legacy', memberIds: ['a', 'ghost'] });

  // Reopened WITH the roster (as the Gate wires it), an add to that room must
  // refuse and name the dead member rather than bless the broken roster.
  const verified = createBotGroupStore(home, { listBotIds: async () => ['a', 'b'] });
  await assert.rejects(verified.addMembers(legacy.id, ['b']), (error) => {
    assert.equal(error.code, 'unknown_member');
    assert.match(error.message, /ghost/);
    return true;
  });
  assert.deepEqual(
    (await verified.get(legacy.id)).memberIds,
    ['a', 'ghost'],
    'the refused add changed nothing',
  );
});
