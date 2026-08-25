import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBotGroupStore, transcriptEntriesForSend } from '../core/cli-environments/bot-groups.mjs';

async function rawStoreFile(home) {
  try {
    return JSON.parse(await readFile(join(home, 'bot-groups.json'), 'utf8'));
  } catch {
    return { groups: [], transcripts: {} };
  }
}

test('a disband racing an in-flight append cannot resurrect the room', async () => {
  for (let trial = 0; trial < 5; trial += 1) {
    const home = await mkdtemp(join(tmpdir(), 'gate-group-races-'));
    const store = createBotGroupStore(home);
    const created = await store.create({ name: 'crew', memberIds: ['coder', 'researcher'] });
    await store.appendMessages(created.id, transcriptEntriesForSend({ text: 'first' }));

    // Launch order A: the append is issued before the disband, so under the
    // mutation queue it completes first and the disband then removes the room.
    const append = store
      .appendMessages(created.id, transcriptEntriesForSend({ text: 'in flight' }))
      .then(
        (length) => ({ ok: true, length }),
        (error) => ({ ok: false, code: error.code }),
      );
    const disband = store.delete(created.id).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, code: error.code }),
    );
    const [appendOutcome, disbandOutcome] = await Promise.all([append, disband]);

    assert.equal(disbandOutcome.ok, true, `trial ${trial}: disband raced a live room`);
    if (!appendOutcome.ok) assert.equal(appendOutcome.code, 'unknown_group');
    const rawA = await rawStoreFile(home);
    assert.equal(
      rawA.groups.filter((group) => group.id === created.id).length,
      0,
      `trial ${trial}: disbanded room resurrected on disk`,
    );
    assert.ok(
      !(created.id in (rawA.transcripts ?? {})),
      `trial ${trial}: transcript of a disbanded room resurrected on disk`,
    );

    // Launch order B: the disband is issued first, so the append must find no
    // room and refuse instead of writing stale state over the deletion.
    const homeB = await mkdtemp(join(tmpdir(), 'gate-group-races-'));
    const storeB = createBotGroupStore(homeB);
    const createdB = await storeB.create({ name: 'crew', memberIds: ['coder', 'researcher'] });

    const disbandB = storeB.delete(createdB.id).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, code: error.code }),
    );
    const appendB = storeB
      .appendMessages(createdB.id, transcriptEntriesForSend({ text: 'in flight' }))
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, code: error.code }),
      );
    const [disbandOutcomeB, appendOutcomeB] = await Promise.all([disbandB, appendB]);

    assert.equal(disbandOutcomeB.ok, true, `trial ${trial} (reversed): disband raced a live room`);
    if (!appendOutcomeB.ok) assert.equal(appendOutcomeB.code, 'unknown_group');
    const rawB = await rawStoreFile(homeB);
    assert.equal(
      rawB.groups.filter((group) => group.id === createdB.id).length,
      0,
      `trial ${trial} (reversed): disbanded room resurrected on disk`,
    );
    assert.ok(!(createdB.id in (rawB.transcripts ?? {})));
  }
});

test('concurrent appends to one room all land exactly once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-group-races-'));
  const store = createBotGroupStore(home);
  const created = await store.create({ name: 'crew', memberIds: ['coder', 'researcher'] });

  // Unserialized, every append reads the same base file and its write clobbers
  // the others: most sends silently vanish. Queued, each lands on top of the
  // previous one.
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store
        .appendMessages(created.id, transcriptEntriesForSend({ text: `msg-${index}` }))
        .then(() => ({ ok: true }), (error) => ({ ok: false, code: error.code })),
    ),
  );

  assert.deepEqual(
    outcomes.filter((outcome) => !outcome.ok),
    [],
    'every concurrent append must succeed against a live room',
  );
  const history = await store.history(created.id);
  const texts = history.map((entry) => entry.text);
  assert.equal(history.length, 8);
  assert.equal(new Set(texts).size, 8, `expected 8 distinct entries, got: ${texts.join(', ')}`);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(texts.includes(`msg-${index}`), `msg-${index} lost by a racing append`);
  }
});

test('concurrent creates never lose a room', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gate-group-races-'));
  const store = createBotGroupStore(home);

  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      store.create({ name: `room-${index}`, memberIds: ['coder', 'researcher'] }),
    ),
  );

  const listed = await store.list();
  assert.equal(listed.length, 6, `expected all 6 rooms to survive, got ${listed.length}`);
  assert.equal(new Set(listed.map((group) => group.id)).size, 6);
});
