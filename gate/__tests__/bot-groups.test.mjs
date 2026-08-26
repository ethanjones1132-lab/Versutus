import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBotGroupStore, groupTurnPrompt, isSilentReply, MAX_GROUP_HISTORY, planGroupRounds, transcriptEntriesForSend, validateGroup } from '../core/cli-environments/bot-groups.mjs';

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

test('delete disbands a room and its transcript, refusing unknown ids', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['a', 'b', 'c'] });
  await store.appendMessages(
    created.id,
    transcriptEntriesForSend({ text: 'hi', replies: [{ botId: 'a', text: 'yo' }] }),
  );

  // Disband removes the room AND the stored transcript together — a
  // disbanded room must never resurface with its history.
  assert.deepEqual(await store.delete(created.id), { ok: true });
  assert.equal(await store.get(created.id), null);
  const raw = JSON.parse(await readFile(join(home, 'bot-groups.json'), 'utf8'));
  assert.equal(raw.groups.length, 0);
  assert.deepEqual(raw.transcripts, {});

  // The room is really gone: the same shape creates fresh without a clash.
  const again = await store.create({ name: 'crew', memberIds: ['a', 'b', 'c'] });
  assert.notEqual(again.id, created.id);

  await assert.rejects(store.delete('missing'), (error) => {
    assert.equal(error.code, 'unknown_group');
    assert.equal(error.status, 404);
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

// ─── group turns must actually be a conversation ────────────────────
// Observed live 2026-08-25: one message to a 3-bot room produced NINE replies
// — each bot answered three times, near-verbatim. Every step was handed the
// same original prompt with no sight of what anyone else had said, so there
// was nothing for a later round to build on and nothing to make it stop.

test('the first speaker gets the plain message', () => {
  const prompt = groupTurnPrompt({ text: 'status please', replies: [], botId: 'needle' });
  assert.equal(prompt, 'status please');
});

test('later speakers see what was already said, and are told to add only what is new', () => {
  const prompt = groupTurnPrompt({
    text: 'status please',
    replies: [{ botId: 'needle', text: 'Two leads open.' }],
    botId: 'herald',
  });
  assert.match(prompt, /status please/);
  assert.match(prompt, /needle: Two leads open\./);
  // The instruction that lets a round end instead of looping the same answer.
  assert.match(prompt, /nothing to add/i);
});

test('a bot never has its own words quoted back at it', () => {
  const prompt = groupTurnPrompt({
    text: 'status',
    replies: [{ botId: 'herald', text: 'mine' }, { botId: 'needle', text: 'theirs' }],
    botId: 'herald',
  });
  assert.match(prompt, /needle: theirs/);
  assert.doesNotMatch(prompt, /herald: mine/);
});

test('an empty reply ends the round rather than padding it', () => {
  // deliverGroupMessage breaks on a blank reply; this is the contract that
  // makes "say nothing when you have nothing" a real exit.
  assert.equal(isSilentReply(''), true);
  assert.equal(isSilentReply('   '), true);
  assert.equal(isSilentReply('[silent]'), true);
  assert.equal(isSilentReply('(nothing to add)'), true);
  assert.equal(isSilentReply('Two leads open.'), false);
});

test('every step knows which round it belongs to', () => {
  // Round boundaries are what let one quiet bot be skipped while a whole
  // silent round ends the conversation.
  const planned = planGroupRounds({ memberIds: ['a', 'b'], maxRounds: 2 });
  assert.deepEqual(planned, [
    { botId: 'a', round: 0 }, { botId: 'b', round: 0 },
    { botId: 'a', round: 1 }, { botId: 'b', round: 1 },
  ]);
});

test('one quiet bot does not silence the room', () => {
  // Reproduced live 2026-08-25: breaking on the first silent reply cut a
  // three-bot room down to a single speaker, because bot two had nothing to
  // add and bot three never got asked.
  const spoke = [];
  const steps = planGroupRounds({ memberIds: ['a', 'b', 'c'], maxRounds: 3 });
  const said = { a: 'hello', b: 'nothing to add', c: 'also hello' };
  let silentThisRound = 0;
  let round = 0;
  for (const step of steps) {
    if (step.round !== round) {
      if (silentThisRound >= 3) break;
      round = step.round;
      silentThisRound = 0;
    }
    if (isSilentReply(said[step.botId])) { silentThisRound += 1; continue; }
    spoke.push(step.botId);
  }
  assert.deepEqual(spoke.slice(0, 2), ['a', 'c'], 'c must still be asked after b stays quiet');
});

test('one message means one round — each member speaks once', () => {
  // Three rounds was the original guess and cost 3x for duplicate text.
  const planned = planGroupRounds({ memberIds: ['a', 'b', 'c'] });
  assert.deepEqual(planned.map((s) => s.botId), ['a', 'b', 'c']);
  assert.ok(planned.every((s) => s.round === 0));
});

test('a caller that wants a real multi-round exchange can still ask', () => {
  const planned = planGroupRounds({ memberIds: ['a', 'b'], maxRounds: 3 });
  assert.equal(planned.length, 6);
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

test('a missing store file reads as a fresh, empty store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  assert.deepEqual(await store.list(), []);
  // The first create materialises the file; a fresh start must not refuse.
  const created = await store.create({ name: 'crew', memberIds: ['a', 'b'] });
  assert.ok(created.id);
  assert.equal((await store.list()).length, 1);
});

test('a store file that will not parse fails loud instead of reading empty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  // Truncated mid-write, as a force-kill can leave it.
  await writeFile(join(home, 'bot-groups.json'), '{"groups": [', 'utf8');
  const store = createBotGroupStore(home);

  // Every read path refuses rather than pretending the store is empty — a
  // truncated file must never read as "no rooms yet".
  await assert.rejects(store.list(), (error) => {
    assert.equal(error.code, 'store_corrupt');
    assert.equal(error.status, 500);
    assert.match(error.message, /corrupt/);
    return true;
  });
  await assert.rejects(store.create({ name: 'crew', memberIds: ['a', 'b'] }), (error) => {
    assert.equal(error.code, 'store_corrupt');
    assert.equal(error.status, 500);
    return true;
  });
  await assert.rejects(
    store.appendMessages('room-1', transcriptEntriesForSend({ text: 'hi' })),
    (error) => {
      assert.equal(error.code, 'store_corrupt');
      return true;
    },
  );

  // The failing write never ran: the corrupt bytes are still on disk,
  // intact for recovery, instead of being overwritten by a fresh empty store.
  assert.equal(await readFile(join(home, 'bot-groups.json'), 'utf8'), '{"groups": [');
});

test('writes are atomic: a completed write leaves no temp debris', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-groups-'));
  const store = createBotGroupStore(home);
  const first = await store.create({ name: 'crew', memberIds: ['a', 'b'] });
  await store.appendMessages(first.id, transcriptEntriesForSend({ text: 'hi' }));
  await store.create({ name: 'duo', memberIds: ['c', 'd'] });

  const parsed = JSON.parse(await readFile(join(home, 'bot-groups.json'), 'utf8'));
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.transcripts[first.id].map((entry) => entry.text), ['hi']);

  // A kill can only orphan the .tmp copy; the live store is never a temp
  // path, so a successful write leaves nothing behind.
  await assert.rejects(readFile(join(home, 'bot-groups.json.tmp'), 'utf8'));
});
