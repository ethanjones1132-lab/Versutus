import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTurnJournal } from '../core/turns/turn-journal.mjs';

// A caller id becomes a path segment through `safeSegment`, and the reduction
// is not injective: `..victim` reduces to `victim`. Nothing about another
// caller's turns may cross that reduction - not its list, not its status, not
// its Stop, and not its files.

const delta = (text) => JSON.stringify({ choices: [{ delta: { content: text } }] });

test('a caller id that reduces to another caller\'s directory cannot read or overwrite its turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-turn-journal-caller-'));
  const journal = createTurnJournal({ dir, flushMs: 0 });
  try {
    const victim = journal.begin({ callerId: 'victim', turnId: 'turn-1', sessionId: 'ses_1' });
    victim.append(delta('the victim answer'));
    victim.finish('done');
    await journal.flush();

    // `..victim` reduces to the segment `victim`, but it is not that caller.
    assert.deepEqual(await journal.list('..victim'), [], 'the alias lists nothing of the victim\'s');
    assert.deepEqual(await journal.list('..victim', { sessionId: 'ses_1' }), []);
    assert.equal(await journal.get('..victim', 'turn-1'), null, 'the alias cannot read the victim\'s turn');
    assert.equal(await journal.cancel('..victim', 'turn-1'), false, 'the alias cannot stop the victim\'s turn');
    const replayed = [];
    await journal.subscribe('..victim', 'turn-1', 0, (event) => replayed.push(event));
    assert.deepEqual(replayed, [null], 'the alias replays no frame of the victim\'s turn');

    // Beginning the victim's turn id through the alias must not take the file
    // over: its meta would be rewritten and its reply deleted. The alias turn is
    // recorded nowhere instead.
    const hijack = journal.begin({ callerId: '..victim', turnId: 'turn-1' });
    hijack.append(delta('a takeover'));
    hijack.finish('done');
    await journal.flush();
    assert.equal(await journal.get('..victim', 'turn-1'), null, 'the refused begin journalled no turn of its own');

    // A turn id of its own is journalled separately, and stays invisible to the
    // caller whose directory its id resolves to.
    const alias = journal.begin({ callerId: '..victim', turnId: 'turn-2' });
    alias.append(delta('not the victim\'s'));
    alias.finish('done');
    await journal.flush();

    assert.deepEqual(
      (await journal.list('victim')).map((meta) => meta.turnId),
      ['turn-1'],
      'the victim lists only its own turn',
    );
    assert.equal(await journal.get('victim', 'turn-2'), null);
    assert.deepEqual(
      (await journal.list('..victim')).map((meta) => meta.turnId),
      ['turn-2'],
      'and the alias lists only its own',
    );

    // A caller id that reduces to no segment at all (`...`) names no directory:
    // it must not land in a shared fallback folder.
    const nothing = journal.begin({ callerId: '...', turnId: 'turn-9' });
    nothing.append(delta('nowhere'));
    nothing.finish('done');
    await journal.flush();
    assert.deepEqual(await journal.list('...'), []);
    assert.deepEqual(await journal.list('anonymous'), []);
    assert.equal(await journal.get('...', 'turn-9'), null);
    assert.deepEqual((await readdir(dir)).sort(), ['victim'], 'only the caller that owns the directory has one');

    // The victim's turn is whole, and its meta still names its caller.
    const known = await journal.get('victim', 'turn-1');
    assert.equal(known.status, 'done');
    assert.equal(known.text, 'the victim answer');
    const meta = JSON.parse((await readFile(join(dir, 'victim', 'turn-1.jsonl'), 'utf8')).split('\n')[0]);
    assert.equal(meta.callerId, 'victim');
  } finally {
    await journal.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
