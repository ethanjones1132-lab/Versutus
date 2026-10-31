import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBackendRunStreams } from '../core/cli-environments/backend-run-streams.mjs';

/**
 * VS-020: "a single writer per run" has to hold for the WHOLE run, not just
 * while two relays overlap.
 *
 * The Gate relays `/v1/runs/{id}/events` from Hermes and tees the bytes into
 * `<gateHome>/run-streams/<id>.sse`. Two relays of the same live run are
 * opened together; the first claims the tee, the second passes bytes through.
 * That held only while they overlapped: a relay whose claim landed AFTER the
 * first relay had reached the stream's clean end (`markComplete`) and released
 * the tee (`end`) claimed the run again. The file already carried its
 * completeness marker, so begin() correctly did not truncate it — and the
 * straggler appended a second copy of frames the archive already held. Readable,
 * and wrong: the archive no longer replays exactly what the backend sent.
 *
 * The store now remembers the runs this process has COMPLETED and refuses a
 * live claim for one of them (`claimLive`), while a torn relay's unmarked
 * partial still heals (it never reached markComplete, so it is not remembered).
 * The memory is a bounded FIFO; the on-disk marker stays the durable truth.
 */

const FRAMES = [
  'data: {"type":"run.started","sequence":1}\n\n',
  'data: {"type":"message.delta","sequence":2,"data":{"text":"hello"}}\n\n',
  'data: {"type":"run.completed","sequence":3,"data":{"exit_code":0}}\n\n',
];

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A temp streams directory per case: no case can see another's archive. */
async function streamsDir() {
  const root = await mkdtemp(join(tmpdir(), 'gate-runstreams-writer-'));
  roots.push(root);
  return join(root, 'streams');
}

/** Drive one full, single-writer live relay through the real store. */
function completeRun(store, runId, frames = FRAMES) {
  assert.equal(store.claimLive(runId), true, `the first live claim of ${runId} wins the tee`);
  assert.equal(store.isActive(runId), true);
  for (const frame of frames) store.append(runId, Buffer.from(frame));
  store.markComplete(runId);
  store.end(runId);
  assert.equal(store.isActive(runId), false, 'the relay released the tee');
}

async function archived(dir, runId) {
  return readFile(join(dir, `${runId}.sse`), 'utf8');
}

test('concurrent live claims of one run yield exactly one writer', async () => {
  const dir = await streamsDir();
  const store = createBackendRunStreams(dir, { maxRuns: 50 });

  const claims = [store.claimLive('run_1'), store.claimLive('run_1'), store.claimLive('run_1')];
  assert.deepEqual(claims, [true, false, false], 'only the first of the concurrent relays may tee');
  assert.equal(store.begin('run_1'), false, 'begin() agrees while the tee is held');
  assert.equal(store.isActive('run_1'), true);

  // The winner archives the stream; the pass-through relays write nothing.
  for (const frame of FRAMES) store.append('run_1', Buffer.from(frame));
  store.markComplete('run_1');
  store.end('run_1');

  assert.equal(await archived(dir, 'run_1'), FRAMES.join(''), 'one writer, one copy');
  assert.equal(store.isComplete('run_1'), true);
});

test('a run this process completed is never teed again: not one archive byte moves', async () => {
  const dir = await streamsDir();
  const store = createBackendRunStreams(dir, { maxRuns: 50 });

  completeRun(store, 'run_1');
  assert.equal(await archived(dir, 'run_1'), FRAMES.join(''));
  assert.equal(store.isComplete('run_1'), true);

  // The straggler: opened alongside the first relay, but its claim is
  // evaluated only after that relay completed and released the run.
  assert.equal(store.claimLive('run_1'), false, 'a completed run must not be re-teed');
  assert.equal(store.isActive('run_1'), false, 'a refused claim must not leave the run looking live');
  // Its relay still forwards every byte to its own client — it just archives
  // nothing, exactly like a concurrent pass-through relay.
  for (const frame of FRAMES) store.append('run_1', Buffer.from(frame));
  store.end('run_1');

  assert.equal(await archived(dir, 'run_1'), FRAMES.join(''), 'the archive must still hold exactly one copy of the stream');
  assert.equal(store.isComplete('run_1'), true);

  // And however often the run is re-streamed, the archive stays final.
  assert.equal(store.claimLive('run_1'), false);
  store.append('run_1', Buffer.from('data: {"type":"message.delta","sequence":4}\n\n'));
  store.end('run_1');
  assert.equal(await archived(dir, 'run_1'), FRAMES.join(''), 'a re-stream must not change an archived byte');
  assert.equal((await store.read('run_1')).toString(), FRAMES.join(''), 'read() serves the single copy');
});

test('an unmarked partial is still reset and re-teed, never doubled', async () => {
  const dir = await streamsDir();
  await mkdir(dir, { recursive: true });
  // An older relay died mid-run: partial bytes on disk, no completeness marker.
  await writeFile(join(dir, 'run_p.sse'), FRAMES[0] + FRAMES[1]);

  const store = createBackendRunStreams(dir, { maxRuns: 50 });
  assert.equal(store.claimLive('run_p'), true, 'a torn partial is not a completed run');
  store.append('run_p', Buffer.from(FRAMES[0]));
  store.end('run_p');
  assert.equal(await archived(dir, 'run_p'), FRAMES[0], 'the stale prefix must be replaced, not doubled');
  assert.equal(store.isComplete('run_p'), false);

  // The heal of the same run: the upstream re-streams from its first event.
  assert.equal(store.claimLive('run_p'), true, 'an unmarked archive stays healable');
  store.append('run_p', Buffer.from(FRAMES.join('')));
  store.markComplete('run_p');
  store.end('run_p');
  assert.equal(await archived(dir, 'run_p'), FRAMES.join(''), 'the healed archive holds the stream once');
  assert.equal(store.isComplete('run_p'), true);

  // Only now, completed, is the run final.
  assert.equal(store.claimLive('run_p'), false);
});

test('a marked archive is never truncated', async () => {
  const dir = await streamsDir();
  await mkdir(dir, { recursive: true });
  // A previous process reached the run's clean end and died: the marker is on
  // disk, and this process has no memory of the run yet.
  await writeFile(join(dir, 'run_m.sse'), FRAMES.join(''));
  await writeFile(join(dir, 'run_m.complete'), 'complete\n');

  const restarted = createBackendRunStreams(dir, { maxRuns: 50 });
  assert.equal(restarted.claimLive('run_m'), true, 'the on-disk marker is the durable truth across a restart');
  assert.equal(await archived(dir, 'run_m'), FRAMES.join(''), 'begin() must not reset a marked archive');
  restarted.end('run_m');

  // Completed in THIS process: the claim is refused and the bytes are untouched.
  const store = createBackendRunStreams(dir, { maxRuns: 50 });
  completeRun(store, 'run_c');
  assert.equal(store.claimLive('run_c'), false);
  assert.equal(await archived(dir, 'run_c'), FRAMES.join(''), 'a marked, completed archive is never reset');
  store.append('run_c', Buffer.from('TAIL'));
  store.end('run_c');
  assert.equal(await archived(dir, 'run_c'), FRAMES.join(''), 'and nothing may be appended to it either');
});

test('a fresh run id still tees normally, and the byte cap still applies', async () => {
  const dir = await streamsDir();
  const store = createBackendRunStreams(dir, { maxRuns: 3 });
  completeRun(store, 'run_ok');
  assert.equal(await archived(dir, 'run_ok'), FRAMES.join(''), 'a genuinely new run archives exactly once');
  assert.equal(store.isComplete('run_ok'), true);
  assert.equal(store.claimLive('run_ok'), false, '...and is final like every other completed run');

  // The cap: a runaway stream is still bounded, and a capped prefix is never
  // blessed as complete — so it stays healable and is replaced, not doubled.
  const cappedDir = await streamsDir();
  const tiny = createBackendRunStreams(cappedDir, { maxRuns: 3, maxBytesPerRun: 10 });
  assert.equal(tiny.claimLive('big'), true);
  tiny.append('big', Buffer.from('0123456789ABCDEF'));
  assert.equal((await tiny.read('big')).toString(), '0123456789', 'the byte bound still holds');
  tiny.markComplete('big');
  tiny.end('big');
  assert.equal(tiny.isComplete('big'), false, 'a truncated prefix must never read as a complete verdict');
  assert.equal(tiny.claimLive('big'), true, 'a capped run never completed, so its prefix stays healable');
  tiny.append('big', Buffer.from('XYZ'));
  tiny.end('big');
  assert.equal((await tiny.read('big')).toString(), 'XYZ', 'the capped prefix is replaced, not appended to');
});

test('the completed-run memory is bounded: old ids are forgotten, nothing accumulates', async () => {
  const dir = await streamsDir();
  // A tiny bound stands in for the store's default window, so eviction is
  // exercised without writing hundreds of runs.
  const store = createBackendRunStreams(dir, { maxRuns: 1000, completedMemoryLimit: 3 });

  for (let i = 0; i < 10; i += 1) completeRun(store, `run_${i}`);

  // The newest three (the retention window) are still recognised as final.
  for (const id of ['run_7', 'run_8', 'run_9']) {
    assert.equal(store.claimLive(id), false, `${id} is inside the retention window`);
  }

  // The seven older ids were evicted: the memory is a window, not a growing
  // history. A claim is possible again — and even then the marked file is
  // never truncated, so the eviction cannot damage an archive.
  for (let i = 0; i < 7; i += 1) {
    const id = `run_${i}`;
    assert.equal(store.claimLive(id), true, `${id} should have been evicted from the bounded memory`);
    assert.equal(await archived(dir, id), FRAMES.join(''), 'an evicted run keeps its whole archive');
    store.end(id);
  }

  // Claims of evicted ids must not push anything out of the window: it is
  // still the three most recent completions that are remembered.
  for (const id of ['run_7', 'run_8', 'run_9']) {
    assert.equal(store.claimLive(id), false, `${id} must still be inside the retention window`);
  }
});
