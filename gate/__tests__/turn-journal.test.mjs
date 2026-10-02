import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, readdir as nodeReaddir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTurnJournal } from '../core/turns/turn-journal.mjs';

// The journal is the contract of docs/design/durable-turns.md 3.2: a turn's
// frames on disk, in order, with a meta line that says how it ended — so a
// phone that was away (or a Gate that restarted) can still say what happened.

async function makeDir() {
  return mkdtemp(join(tmpdir(), 'gate-turn-journal-'));
}

/**
 * Every journal a test opens, so `clean` can settle all of them.
 *
 * In that order, and with retries: `close()` settles every coalesced write and
 * every background task, so nothing of the journal is still touching the
 * directory when the removal starts — which is the difference between a clean
 * test and an `ENOTEMPTY` two runs in seven.
 */
const open = [];
const journalFor = (options) => {
  const journal = createTurnJournal(options);
  open.push(journal);
  return journal;
};

async function clean(dir) {
  for (const journal of open.splice(0)) await journal.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

/** Bounded poll, for the retention sweep, which is a background task. */
async function until(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const delta = (text) => JSON.stringify({ choices: [{ delta: { content: text } }] });
const toolFrame = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1' }] } }] });

test('a turn records its frames, numbers them, and assembles the reply', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir });
    const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-1', sessionId: 'ses_1' });
    turn.append(delta('hello '));
    turn.append(toolFrame);
    turn.append(delta('world'));
    assert.equal(turn.seq, 3, 'every frame gets the next sequence number');
    turn.finish('done');

    await journal.flush();
    const lines = (await readFile(join(dir, 'phone-a', 'turn-1.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 4, 'the meta line, then one line per frame');
    const events = lines.slice(1).map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(events[1].data, toolFrame, 'a frame that carries no text is still recorded');
  } finally {
    await clean(dir);
  }
});

test('a turn finished on disk is readable by another process, text and all', async () => {
  const dir = await makeDir();
  try {
    const first = journalFor({ dir });
    const turn = first.begin({ callerId: 'phone-a', turnId: 'turn-1', sessionId: 'ses_1', backendId: 'hermes-local', model: 'kilo/x' });
    turn.append(delta('the whole '));
    turn.append(delta('answer'));
    turn.finish('done');
    await first.flush();

    // A new instance knows nothing but the directory: the reply, the status and
    // the session must all come back off disk.
    const second = journalFor({ dir });
    const known = await second.get('phone-a', 'turn-1');
    assert.equal(known.status, 'done');
    assert.equal(known.text, 'the whole answer');
    assert.equal(known.sessionId, 'ses_1');
    assert.equal(known.backendId, 'hermes-local');
    assert.equal(known.model, 'kilo/x');
    assert.equal(known.lastSeq, 2);
    assert.equal(known.textLength, 16);
    assert.equal(await second.get('phone-b', 'turn-1'), null, 'a turn belongs to the caller that named it');
  } finally {
    await clean(dir);
  }
});

test('the status change is an atomic meta rewrite that keeps every event', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir, flushMs: 5 });
    const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
    turn.append(delta('partial'));
    await journal.flush();
    turn.finish('failed', { error: { message: 'the backend refused', code: 'backend_error' }, reason: null });
    await journal.flush();

    const path = join(dir, 'phone-a', 'turn-1.jsonl');
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    const meta = JSON.parse(lines[0]);
    assert.equal(meta.status, 'failed');
    assert.deepEqual(meta.error, { message: 'the backend refused', code: 'backend_error' });
    assert.equal(typeof meta.finishedAt, 'number');
    assert.equal(lines.length, 2, 'rewriting the meta must not lose the frames behind it');
    assert.deepEqual(
      (await readdir(join(dir, 'phone-a'))).sort(),
      ['turn-1.jsonl', 'turn-1.text'],
      'an atomic rewrite leaves no temp file behind',
    );
    // A late frame on a turn that already ended is not a new event.
    turn.append(delta(' too late'));
    assert.equal(turn.seq, 1);
  } finally {
    await clean(dir);
  }
});

test('subscribe replays what it was asked for, then follows, then marks the end', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir, flushMs: 5 });
    const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
    turn.append(delta('one'));
    turn.append(delta('two'));
    turn.append(delta('three'));

    const seen = [];
    const unsubscribe = await journal.subscribe('phone-a', 'turn-1', 1, (event) => seen.push(event));
    assert.deepEqual(seen.map((event) => event.seq), [2, 3], 'replay starts after the sequence it was given');

    turn.append(delta('four'));
    assert.equal(seen.at(-1).data, delta('four'), 'a live frame follows the replay');
    turn.finish('done');
    assert.equal(seen.at(-1), null, 'the turn ending is a terminal marker, not a frame');

    unsubscribe();
    const other = journal.begin({ callerId: 'phone-a', turnId: 'turn-2' });
    other.append(delta('a different turn'));
    assert.equal(seen.length, 4, 'a released subscription hears nothing further');
  } finally {
    await clean(dir);
  }
});

test('subscribing to a finished turn replays it and ends at once', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir, flushMs: 0 });
    const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
    turn.append(delta('done already'));
    turn.finish('done');

    const seen = [];
    await journal.subscribe('phone-a', 'turn-1', 0, (event) => seen.push(event));
    assert.deepEqual(seen.map((event) => event?.seq ?? 'terminal'), [1, 'terminal']);
  } finally {
    await clean(dir);
  }
});

test('the per-turn event cap drops the oldest deltas and says so, keeping the text', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir, maxEventBytes: 400, flushMs: 0 });
    const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
    for (let index = 0; index < 40; index += 1) turn.append(delta(`chunk-${index} `));
    turn.append(delta('THE END'));
    turn.finish('done');

    const known = await journal.get('phone-a', 'turn-1');
    assert.ok(known.droppedEvents > 0, 'a capped turn says its replay is incomplete');
    assert.equal(
      known.text,
      `${Array.from({ length: 40 }, (_, index) => `chunk-${index} `).join('')}THE END`,
      'capping the log never costs the assembled reply',
    );
    // The file really is bounded: what survived is a tail, not everything.
    const raw = await readFile(join(dir, 'phone-a', 'turn-1.jsonl'), 'utf8');
    assert.ok(raw.length < 400 + 400, `the log is capped (${raw.length} bytes)`);
    assert.ok(raw.includes('THE END'), 'the newest frames survive');
  } finally {
    await clean(dir);
  }
});

test('pruning drops the oldest finished turns and never a running one', async () => {
  const dir = await makeDir();
  try {
    let clock = 1_000_000;
    // A sweep is a background task, so the interval is injected at the scale a
    // test can wait for: nothing a turn does waits for it.
    const journal = journalFor({
      dir, now: () => clock, maxTurns: 2, retentionMs: 7 * 24 * 60 * 60 * 1000, pruneIntervalMs: 10,
    });
    const finish = (turnId) => {
      const turn = journal.begin({ callerId: 'phone-a', turnId });
      turn.append(delta('short'));
      turn.finish('done');
    };
    finish('turn-old1');
    clock += 1000;
    finish('turn-old2');
    clock += 1000;
    // Still running when the sweep passes: a turn nobody can see yet is not a
    // candidate, however old the finished turns beside it are.
    const live = journal.begin({ callerId: 'phone-a', turnId: 'turn-live' });
    live.append(delta('still going'));
    clock += 1000;
    finish('turn-new1');

    // Retention: two finished turns are kept (the cap), the oldest finished one
    // goes, and the turn still running is not a candidate however much history
    // piles up beside it.
    clock += 1000;
    finish('turn-trigger');
    // The sweep is background and one pass drops only the excess it saw when it
    // started. Waiting on old1 alone can catch a mid-sweep roster that still
    // holds old2; wait for the kept set the cap describes.
    const kept = ['turn-live', 'turn-new1', 'turn-trigger'];
    assert.ok(
      await until(async () => {
        const listed = await journal.list('phone-a');
        const ids = listed.map((meta) => meta.turnId).sort();
        return ids.length === kept.length && ids.every((id, i) => id === kept[i]);
      }),
      'the oldest finished turns are swept once the interval passes; a running turn is not a candidate',
    );
    const listed = await journal.list('phone-a');
    assert.deepEqual(
      listed.map((meta) => meta.turnId).sort(),
      kept,
    );
    assert.equal((await journal.get('phone-a', 'turn-live')).status, 'running');
  } finally {
    await clean(dir);
  }
});

test('a finished turn past the retention window goes, a running one stays', async () => {
  const dir = await makeDir();
  try {
    let clock = 1_000_000;
    const journal = journalFor({ dir, now: () => clock, retentionMs: 10_000, pruneIntervalMs: 10 });
    const old = journal.begin({ callerId: 'phone-a', turnId: 'turn-ancient' });
    old.append(delta('ancient'));
    old.finish('done');
    const live = journal.begin({ callerId: 'phone-a', turnId: 'turn-ancient-running' });
    live.append(delta('still going'));
    clock += 20_000;
    const recent = journal.begin({ callerId: 'phone-a', turnId: 'turn-recent' });
    recent.append(delta('recent'));
    recent.finish('done');

    assert.ok(
      await until(() => journal.get('phone-a', 'turn-ancient').then((meta) => meta === null)),
      'seven days is seven days',
    );
    assert.equal((await journal.get('phone-a', 'turn-ancient-running')).status, 'running');
    assert.equal((await journal.get('phone-a', 'turn-recent')).status, 'done');
  } finally {
    await clean(dir);
  }
});

test('a corrupt or half-written file is skipped, never thrown into a request', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir, flushMs: 0 });
    const good = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
    good.append(delta('readable'));
    good.finish('done');

    await writeFile(join(dir, 'phone-a', 'turn-broken.jsonl'), 'not json at all\n{"seq":1}\n', 'utf8');
    await writeFile(
      join(dir, 'phone-a', 'turn-torn.jsonl'),
      `{"turnId":"turn-torn","status":"done","updatedAt":${Date.now()}}\n{"seq":1,"t":1,"data":"{\n`,
      'utf8',
    );

    assert.equal(await journal.get('phone-a', 'turn-broken'), null);
    assert.equal((await journal.get('phone-a', 'turn-torn')).status, 'done', 'a torn tail costs one frame');
    const listed = await journal.list('phone-a');
    assert.deepEqual(listed.map((meta) => meta.turnId).sort(), ['turn-1', 'turn-torn']);
  } finally {
    await clean(dir);
  }
});

test('a turn id cannot escape the journal directory', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir, flushMs: 0 });
    const turn = journal.begin({ callerId: '../../etc', turnId: '../../passwd', sessionId: 'ses_1' });
    turn.append(delta('contained'));
    turn.finish('done');

    const callers = await readdir(dir);
    assert.deepEqual(callers, ['_.._etc'], `unexpected callers: ${callers.join(', ')}`);
    assert.deepEqual(
      (await readdir(join(dir, '_.._etc'))).sort(),
      ['_.._passwd.jsonl', '_.._passwd.text'],
    );
    // And the real ids still resolve, through the same reduction.
    assert.equal((await journal.get('../../etc', '../../passwd')).status, 'done');
  } finally {
    await clean(dir);
  }
});

test('recoverInterrupted settles every turn the journal still shows as running', async () => {
  const dir = await makeDir();
  try {
    // A previous process, killed mid-turn.
    const first = journalFor({ dir, flushMs: 0 });
    const stuck = first.begin({ callerId: 'phone-a', turnId: 'turn-stuck', sessionId: 'ses_1' });
    stuck.append(delta('half an ans'));
    await first.close();
    const finished = first.begin({ callerId: 'phone-a', turnId: 'turn-done' });
    finished.append(delta('whole answer'));
    finished.finish('done');

    const second = journalFor({ dir });
    const recovered = await second.recoverInterrupted();
    assert.deepEqual(recovered.map((row) => row.turnId), ['turn-stuck']);
    const known = await second.get('phone-a', 'turn-stuck');
    assert.equal(known.status, 'interrupted');
    assert.equal(known.reason, 'gate_restart');
    assert.equal(known.text, 'half an ans', 'what it did manage to say is still readable');
    assert.equal((await second.get('phone-a', 'turn-done')).status, 'done', 'a finished turn is not disturbed');
    assert.deepEqual(await second.recoverInterrupted(), [], 'settling them twice is not a thing');
  } finally {
    await clean(dir);
  }
});

test('Stop is recorded as cancelled, once', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir, flushMs: 0 });
    const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
    turn.append(delta('half'));

    assert.equal(await journal.cancel('phone-a', 'turn-1'), true);
    assert.equal((await journal.get('phone-a', 'turn-1')).status, 'cancelled');
    assert.equal(await journal.cancel('phone-a', 'turn-1'), false, 'a turn already stopped is not stopped again');
    assert.equal(await journal.cancel('phone-a', 'turn-nobody-owns'), false);
  } finally {
    await clean(dir);
  }
});

// ─── The repair claims ─────────────────────────────────────────────────────

test('flush and close are awaitable, so the directory is the caller\'s afterwards', async () => {
  const dir = await makeDir();
  const faults = [];
  const journal = journalFor({ dir, pruneIntervalMs: 10, log: (line) => faults.push(line) });
  const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
  turn.append(delta('half an answer'));
  turn.finish('done');

  // A caller that has flushed or closed the journal owns the directory: nothing
  // of it may still be writing. Awaitable is what makes that promise at all - a
  // bare `close()` cannot promise it, and a `rm` right after one races the sweep
  // (`ENOTEMPTY`, two runs in seven).
  const flushing = journal.flush();
  const closing = journal.close();
  assert.ok(flushing instanceof Promise, 'flush() must be awaitable');
  assert.ok(closing instanceof Promise, 'close() must be awaitable');
  await Promise.all([flushing, closing]);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  open.length = 0;
  await sleep(50);
  assert.deepEqual(faults, [], `the journal touched a directory it had given up: ${faults.join(' | ')}`);
});

test('two turns cannot share one turn id: the second begin is refused by name', async () => {
  const dir = await makeDir();
  try {
    const journal = journalFor({ dir, flushMs: 0 });
    const first = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });

    // Two requests can both find an id unused and then both start one (a double
    // tap, a resend racing the original). The second must not take over the first
    // turn's file and live entry: its Stop is found through that entry, its
    // subscribers hang off it, and its `finish` would evict it — so `begin`
    // refuses, by a name the caller answers as a replay of the running turn.
    assert.throws(
      () => journal.begin({ callerId: 'phone-a', turnId: 'turn-1' }),
      (error) => {
        assert.equal(error.name, 'TurnExistsError');
        assert.equal(error.code, 'turn_exists');
        return true;
      },
    );
    // A different caller is a different turn, as always.
    const theirs = journal.begin({ callerId: 'phone-b', turnId: 'turn-1' });
    theirs.append(delta('theirs'));
    theirs.finish('done');

    first.append(delta('the first turn'));
    first.finish('done');
    const known = await journal.get('phone-a', 'turn-1');
    assert.equal(known.status, 'done', 'the refusal left the running turn whole');
    assert.equal(known.text, 'the first turn');
    assert.equal((await journal.get('phone-b', 'turn-1')).text, 'theirs');

    // And once the turn is over the id is the caller's again.
    const second = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
    second.append(delta('a second turn'));
    second.finish('done');
    assert.equal((await journal.get('phone-a', 'turn-1')).text, 'a second turn');
  } finally {
    await clean(dir);
  }
});

test('the per-turn cap bounds the file, not only what a read hands back', async () => {
  const dir = await makeDir();
  try {
    // Coalesced writes, which is what made the cap a fiction: the frames dropped
    // from memory were already on disk, so the file kept every one of them.
    const journal = journalFor({ dir, maxEventBytes: 1000, flushMs: 20 });
    const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-1' });
    for (let index = 0; index < 300; index += 1) turn.append(delta(`chunk-${index} `));
    turn.finish('done');
    await journal.flush();

    const lines = (await readFile(join(dir, 'phone-a', 'turn-1.jsonl'), 'utf8')).trim().split('\n');
    const meta = JSON.parse(lines[0]);
    const frames = lines.slice(1).reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
    assert.ok(frames <= 1000, `the frame log is ${frames} bytes against a 1000-byte cap`);
    assert.ok(meta.droppedEvents > 0, 'and the meta says the replay is incomplete');
    assert.ok(lines.at(-1).includes('chunk-299'), 'what survived is the newest tail');
    // What the cap may never cost is the answer.
    assert.equal(
      (await journal.get('phone-a', 'turn-1')).text,
      Array.from({ length: 300 }, (_, index) => `chunk-${index} `).join(''),
    );
    // And what a read hands back agrees with what is on disk.
    const seen = [];
    await journal.subscribe('phone-a', 'turn-1', 0, (event) => seen.push(event));
    assert.equal(seen.at(-1), null);
    assert.ok(seen.filter(Boolean).length <= lines.length - 1, 'a replay never invents frames');
    assert.ok((await journal.get('phone-a', 'turn-1')).droppedEvents > 0);
  } finally {
    await clean(dir);
  }
});

test('beginning and finishing a turn reads no other turn, and the sweep still removes', async () => {
  const dir = await makeDir();
  try {
    // A Gate at the documented retention: 300 retained turns on disk.
    await mkdir(join(dir, 'phone-a'), { recursive: true });
    for (let index = 0; index < 300; index += 1) {
      await writeFile(join(dir, 'phone-a', `retained-${index}.jsonl`), `${JSON.stringify({
        turnId: `retained-${index}`,
        callerId: 'phone-a',
        sessionId: 'ses_1',
        status: 'done',
        startedAt: 1,
        updatedAt: 2,
        finishedAt: 1_000,
        lastSeq: 0,
      })}\n`, 'utf8');
    }
    let clock = 1_000_000;
    // The journal's own filesystem calls, counted: retention used to be a
    // readdir of every caller and a readFileSync + JSON.parse of every line of
    // every turn file, twice per chat turn, on the Gate's one event loop.
    const touched = [];
    const countedFs = {
      readdir: (...args) => { touched.push(`readdir ${args[0]}`); return nodeReaddir(...args); },
      readFileSync: (...args) => { touched.push(`readFileSync ${args[0]}`); return nodeFs.readFileSync(...args); },
      openSync: (...args) => { touched.push(`openSync ${args[0]}`); return nodeFs.openSync(...args); },
      readSync: (...args) => { touched.push(`readSync ${args[0]}`); return nodeFs.readSync(...args); },
    };
    const journal = journalFor({ dir, now: () => clock, pruneIntervalMs: 30, retentionMs: 100_000, fs: countedFs });

    // The one sweep this process owes the turns on disk, and the index it builds
    // for it, are background work: settled before anything is measured.
    await journal.flush();
    touched.length = 0;

    const turn = journal.begin({ callerId: 'phone-a', turnId: 'turn-new' });
    turn.append(delta('one frame'));
    turn.finish('done');
    await journal.flush();
    assert.deepEqual(
      touched.filter((line) => !line.includes('turn-new')),
      [],
      `a chat turn touched other turns' files: ${touched.filter((line) => !line.includes('turn-new')).slice(0, 3).join(', ')}`,
    );

    // The sweep is throttled, not skipped: past the interval it runs from the
    // index, and it is the retention window (not the count cap) that takes the
    // 300 retained turns.
    clock += 20_000;
    assert.ok(
      await until(async () => (await readdir(join(dir, 'phone-a'))).filter((name) => name.endsWith('.jsonl')).length === 1, 15_000),
      'the background sweep still removes the oldest finished turns',
    );
    assert.equal((await journal.get('phone-a', 'turn-new')).status, 'done', 'and keeps what is recent');
  } finally {
    await clean(dir);
  }
});
