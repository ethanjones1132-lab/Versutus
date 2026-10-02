import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionIndex, parseSessionIndexKey, sessionIndexKey } from '../core/session-index.mjs';

// The Gate's own copy of a session list (SPD-1/SPD-2). A Hermes list costs
// 3-38 s against a 6.2 GB state.db, so this copy is what makes a warm list
// instant -- and its durability is what makes the speed survive a restart.

const dirs = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-session-index-'));
  dirs.push(dir);
  return dir;
}

function row(id, extra = {}) {
  return { id, source: 'hermes', title: `session ${id}`, ...extra };
}

async function onlyFile(dir) {
  const names = await readdir(dir);
  assert.equal(names.length, 1, `expected one file, found ${names.join(', ')}`);
  return join(dir, names[0]);
}

test('the key is the environment and the Bot it was read from', () => {
  assert.equal(sessionIndexKey('hermes-local', undefined), 'hermes-local|');
  assert.equal(sessionIndexKey('hermes-local', 'atlas'), 'hermes-local|atlas');
});

test('a key reads back as the same environment and Bot', () => {
  assert.deepEqual(parseSessionIndexKey('hermes-local|atlas'), { backendId: 'hermes-local', botId: 'atlas' });
  assert.deepEqual(parseSessionIndexKey('hermes-local|'), { backendId: 'hermes-local', botId: undefined });
  // A Bot id that happens to contain the separator is read whole, not cut.
  assert.deepEqual(parseSessionIndexKey('hermes-local|a|b'), { backendId: 'hermes-local', botId: 'a|b' });
});

test('the copy can say which windows hold a session id', async () => {
  // A scope-less exact-id lookup asks this first: the id alone says nothing
  // about where it lives, and asking the first attached environment instead
  // found nothing on a Gate where Claude Code sorted before Hermes.
  const dir = await tempDir();
  const index = createSessionIndex({ dir, now: () => 2000 });
  await index.refresh('hermes-local|', async () => [row('api_1'), row('api_2')], { limit: 50 });
  await index.refresh('hermes-local|atlas', async () => [row('api_9')], { limit: 50 });

  assert.deepEqual(await index.keysWithSession('api_1'), ['hermes-local|']);
  assert.deepEqual(await index.keysWithSession('api_9'), ['hermes-local|atlas']);
  // Nobody claims it: the caller is left to sweep, which is the honest answer.
  assert.deepEqual(await index.keysWithSession('api_404'), []);
  assert.deepEqual(await index.keysWithSession(''), []);
});

test('a window whose id was retired stops claiming it', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir });
  await index.refresh('hermes-local|', async () => [row('api_1'), row('api_2')], { limit: 50 });
  await index.remove('hermes-local|', 'api_2');

  assert.deepEqual(await index.keysWithSession('api_2'), []);
  assert.deepEqual(await index.keysWithSession('api_1'), ['hermes-local|']);
});

test('a second refresh joins the read already running instead of starting another', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, now: () => 1000 });
  let calls = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const loader = async () => {
    calls += 1;
    await held;
    return [row('s1'), row('s2')];
  };

  // Two screens opening at once on a 38 s query must cost ONE read of Hermes.
  const first = index.refresh('hermes-local|', loader, { limit: 50 });
  const second = index.refresh('hermes-local|', loader, { limit: 50 });
  assert.equal(first, second, 'the second caller must be given the first read');

  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(calls, 1, 'the backend was asked once');
  assert.deepEqual(one.sessions.map((entry) => entry.id), ['s1', 's2']);
  assert.deepEqual(two.sessions, one.sessions);
  assert.equal(one.fetchedLimit, 50, 'the page it was read at is part of the answer');
  assert.equal(one.refreshedAt, 1000);
});

test('a window survives a restart: a new index reads it back from disk', async () => {
  const dir = await tempDir();
  const first = createSessionIndex({ dir, now: () => 4242 });
  await first.refresh('hermes-local|', async () => [row('s1'), row('s2')], { limit: 20 });
  await first.flush();

  const second = createSessionIndex({ dir });
  const stored = await second.get('hermes-local|');
  assert.deepEqual(stored.sessions.map((entry) => entry.id), ['s1', 's2']);
  assert.equal(stored.fetchedLimit, 20);
  assert.equal(stored.refreshedAt, 4242, 'the age of the copy has to survive, or every read would think it is fresh');
});

test('a join never answers a read that asked for a bigger window', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, now: () => 1000 });
  const asked = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const loader = async (limit) => {
    asked.push(limit);
    await held;
    return Array.from({ length: limit }, (_, i) => row(`s${i + 1}`));
  };

  // "Load older" arriving while a 20-row refill is still on the wire. Joining
  // that read would answer 20 rows to a 200-row ask, and a short page the app
  // cannot tell from a whole catalogue is how a Bot Chat that IS there reads as
  // absent — so the bigger ask has to make a read of its own.
  const small = index.refresh('hermes-local|', loader, { limit: 20 });
  const big = index.refresh('hermes-local|', loader, { limit: 200 });
  assert.notEqual(big, small, 'a 20-row read cannot be the answer to a 200-row ask');

  release();
  const filled = await big;
  assert.deepEqual(asked, [20, 200], 'the bigger window is really asked for, and only after the first read is done');
  assert.equal(filled.fetchedLimit, 200);
  assert.equal(filled.sessions.length, 200);
  assert.equal((await index.get('hermes-local|')).fetchedLimit, 200, 'and the copy ends up holding the bigger window');
});

test('a write-through reaches a window a restart left on disk', async () => {
  const dir = await tempDir();
  const before = createSessionIndex({ dir });
  await before.refresh('hermes-local|', async () => [row('s1', { title: 'One' }), row('s2', { title: 'Two' })], { limit: 20 });
  await before.flush();

  // The next process knows nothing about this key until it is asked. A mutator
  // working on the empty map alone is a no-op, so the delete would not happen
  // and the turn would replace the whole window with the one row it knew —
  // which claims no window, so the next read falls back to the slow query the
  // copy exists to avoid.
  const restarted = createSessionIndex({ dir });
  await restarted.remove('hermes-local|', 's1');
  await restarted.upsert('hermes-local|', { id: 's2', last_active: 99 });
  await restarted.flush();

  const stored = await createSessionIndex({ dir }).get('hermes-local|');
  assert.deepEqual(stored.sessions.map((entry) => entry.id), ['s2'], 'the delete landed, and the turn did not shrink the window');
  assert.equal(stored.sessions[0].title, 'Two', 'the fields the read measured are still there');
  assert.equal(stored.sessions[0].last_active, 99, 'and the field the turn knew is applied');
  assert.equal(stored.fetchedLimit, 20, 'a window a real read filled is still a window');
});

test('a write-through never erases what a live read measured', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, rowTemplate: (id) => ({ id, title: null, message_count: 0, started_at: 0, preview: '' }) });
  await index.refresh('hermes-local|', async () => [row('mid', { title: 'Mid', message_count: 12, started_at: 5 })], { limit: 10 });

  // A turn knows the id and the time. Everything it does not know is absent,
  // not zero, and absent must never overwrite what the copy measured.
  await index.upsert('hermes-local|', { id: 'mid', title: undefined, message_count: undefined, last_active: 99 });

  const held = (await index.get('hermes-local|')).sessions[0];
  assert.equal(held.title, 'Mid', 'a missing field is not a field to erase');
  assert.equal(held.message_count, 12);
  assert.equal(held.last_active, 99);
  assert.equal(held.started_at, 5, 'and so is the one it does not mention');
});

test('a session the copy has never read is stored as a whole row', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, rowTemplate: (id) => ({ id, title: null, message_count: 0, started_at: 0, preview: '' }) });

  await index.upsert('hermes-local|atlas', { id: 'brand-new', last_active: 99 });

  const fresh = (await index.get('hermes-local|atlas')).sessions[0];
  // The app reads these fields, and a missing one is a hole rather than a zero.
  assert.equal(fresh.started_at, 0);
  assert.equal(fresh.preview, '');
  assert.equal(fresh.message_count, 0);
  assert.equal(fresh.last_active, 99, 'the one field the action knew');
  assert.equal((await index.get('hermes-local|atlas')).fetchedLimit, 0, 'and it still claims no window');
});

test('a key that was never filled has no window', async () => {
  const index = createSessionIndex({ dir: await tempDir() });
  assert.equal(await index.get('hermes-local|atlas'), null);
});

test('a write lands whole, and a tmp file left by a kill is ignored on load', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir });
  await index.refresh('hermes-local|', async () => [row('s1')], { limit: 5 });
  await index.flush();

  const file = await onlyFile(dir);
  assert.match(file, /\.json$/, 'the rename lands the whole file; no half-written target');
  // What a kill between write and rename leaves behind: a sibling .tmp holding
  // bytes that were never renamed. It must never be read as the window.
  await writeFile(`${file}.tmp`, '{"sessions":[{"id":"half-written"', 'utf8');

  const reloaded = await createSessionIndex({ dir }).get('hermes-local|');
  assert.deepEqual(reloaded.sessions.map((entry) => entry.id), ['s1']);
});

test('a corrupt window file is ignored, never fatal', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir });
  await index.refresh('hermes-local|', async () => [row('s1')], { limit: 5 });
  await index.flush();
  const file = await onlyFile(dir);

  const warnings = [];
  await writeFile(file, '{"sessions": [ truncated', 'utf8');
  const corrupt = createSessionIndex({ dir, log: (line) => warnings.push(line) });
  // A bad byte must not become a failed request: the next read simply refills.
  assert.equal(await corrupt.get('hermes-local|'), null);
  assert.ok(warnings.some((line) => /corrupt/.test(line)), 'the operator is told which file was dropped');
  const after = await corrupt.refresh('hermes-local|', async () => [row('s1'), row('s2')], { limit: 5 });
  assert.equal(after.sessions.length, 2, 'the window heals on the next read');
});

test('a window file that is not a window at all is ignored too', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir });
  await index.refresh('hermes-local|', async () => [row('s1')], { limit: 5 });
  await index.flush();
  await writeFile(await onlyFile(dir), JSON.stringify({ sessions: 'not-a-list' }), 'utf8');

  const stored = await createSessionIndex({ dir }).get('hermes-local|');
  assert.equal(stored, null);
});

test('a burst of write-through changes costs one write, holding the final state', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, writeDelayMs: 5_000 });
  await index.refresh('hermes-local|', async () => [], { limit: 10 });
  for (const id of ['s1', 's2', 's3', 's4', 's5']) await index.upsert('hermes-local|', row(id));

  assert.deepEqual(await readdir(dir), [], 'the write is debounced, not skipped');
  await index.flush();
  const names = await readdir(dir);
  assert.equal(names.length, 1, `a burst must coalesce into one write, found ${names.join(', ')}`);
  const stored = JSON.parse(await readFile(join(dir, names[0]), 'utf8'));
  assert.deepEqual(stored.sessions.map((entry) => entry.id), ['s5', 's4', 's3', 's2', 's1']);
});

test('an upsert moves a session to the top and merges onto the row already held', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, now: () => 7 });
  await index.refresh('hermes-local|', async () => [row('old', { title: 'Old' }), row('mid', { title: 'Mid' })], { limit: 10 });

  // A chat turn: the row keeps what a live read knew, with the new activity.
  await index.upsert('hermes-local|', { id: 'mid', last_active: 99 });
  await index.upsert('hermes-local|', { id: 'brand-new', title: 'New thread' });

  const stored = await index.get('hermes-local|');
  assert.deepEqual(stored.sessions.map((entry) => entry.id), ['brand-new', 'mid', 'old']);
  assert.equal(stored.sessions[1].title, 'Mid', 'the fields a live read supplied are kept');
  assert.equal(stored.sessions[1].last_active, 99, 'the fields the action supplied are applied');
  assert.equal(stored.fetchedLimit, 10, 'a write-through does not pretend to be a fresh read');
  assert.equal(stored.refreshedAt, 7);
});

test('a row the Gate created before it ever listed one is kept, and remembered as no window', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir });
  await index.upsert('hermes-local|atlas', row('s1', { title: 'Bot Chat' }));

  const stored = await index.get('hermes-local|atlas');
  assert.equal(stored.sessions.length, 1);
  assert.equal(stored.fetchedLimit, 0, 'nothing has been read from the backend for this key yet');
  assert.equal(stored.refreshedAt, 0);
});

test('a removed session disappears and a renamed one keeps its place', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir });
  await index.refresh('hermes-local|', async () => [row('s1'), row('s2'), row('s3')], { limit: 10 });

  await index.remove('hermes-local|', 's2');
  await index.remove('hermes-local|', 'not-here');
  await index.rename('hermes-local|', 's3', 'Renamed');
  await index.rename('hermes-local|', 'not-here', 'Ignored');

  const stored = await index.get('hermes-local|');
  assert.deepEqual(stored.sessions.map((entry) => entry.id), ['s1', 's3']);
  assert.equal(stored.sessions[1].title, 'Renamed');
  assert.equal(stored.sessions[1].preview, 'Renamed', 'the row has no preview of its own, so it follows the title');
  await index.flush();
  const reloaded = await createSessionIndex({ dir }).get('hermes-local|');
  assert.deepEqual(reloaded.sessions.map((entry) => entry.id), ['s1', 's3']);
});

test('at most maxRows rows are kept per key', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, maxRows: 3 });
  const many = Array.from({ length: 10 }, (_, i) => row(`s${i + 1}`));
  const filled = await index.refresh('hermes-local|', async () => many, { limit: 10 });
  assert.equal(filled.sessions.length, 3, 'the copy is bounded whatever the backend returns');
  assert.equal(index.maxRows, 3, 'the route reads the same cap off the index');

  for (const id of ['x1', 'x2', 'x3', 'x4']) await index.upsert('hermes-local|', row(id));
  const stored = await index.get('hermes-local|');
  assert.deepEqual(stored.sessions.map((entry) => entry.id), ['x4', 'x3', 'x2']);
});

test('the memory bound is the least recently used keys; their files stay on disk', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, maxKeys: 2 });
  await index.refresh('a|', async () => [row('a1')], { limit: 1 });
  // A write the file has not taken yet: if 'a' is still in memory after the
  // eviction below, this row comes back; if it was evicted, the file does not
  // have it and the read below proves the eviction.
  await index.upsert('a|', row('a2'));
  await index.flush();
  assert.deepEqual((await index.get('a|')).sessions.map((entry) => entry.id), ['a2', 'a1']);
  await index.refresh('a|', async () => [row('a1')], { limit: 1 });
  await index.flush();

  await index.refresh('b|', async () => [row('b1')], { limit: 1 });
  await index.refresh('c|', async () => [row('c1')], { limit: 1 });
  await index.flush();

  assert.equal((await readdir(dir)).length, 3, 'every key keeps its file after eviction');
  assert.deepEqual((await index.get('a|')).sessions.map((entry) => entry.id), ['a1'], 'a evicted key is reloaded from its file');
});

test('a write that cannot land never reaches the caller', async () => {
  const dir = await tempDir();
  const warnings = [];
  const index = createSessionIndex({ dir, log: (line) => warnings.push(line) });
  // A directory where the file should be: the rename cannot succeed.
  const blocker = join(dir, await (async () => {
    await index.refresh('hermes-local|', async () => [row('s1')], { limit: 1 });
    await index.flush();
    return (await readdir(dir))[0];
  })());
  await writeFile(blocker, 'now a file, not a directory', 'utf8');

  const unwritable = createSessionIndex({ dir: blocker, log: (line) => warnings.push(line) });
  await unwritable.upsert('hermes-local|', row('s2'));
  await unwritable.flush();

  // The rows are still readable in memory: a Gate that cannot write its cache
  // must still answer sessions.
  assert.equal((await unwritable.get('hermes-local|')).sessions[0].id, 's2');
  assert.ok(warnings.length > 0, 'and it says so rather than failing silently');
});
