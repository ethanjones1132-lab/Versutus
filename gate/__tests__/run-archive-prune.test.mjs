import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunArchive } from '../core/cli-environments/run-archive.mjs';

/**
 * Five runs whose ids sort the OPPOSITE way round from their start times.
 * load() reads a directory with `readdir().sort()`, so before the fix the
 * order it pruned by was run-0 … run-4 — the newest run first — and keeping
 * the last two of that order kept the two OLDEST. Real run ids are random hex,
 * so this ordering is the ordinary case, not a contrived one.
 */
const REVERSED = [
  { runId: 'run-0', ageMs: 0 },
  { runId: 'run-1', ageMs: 10 },
  { runId: 'run-2', ageMs: 20 },
  { runId: 'run-3', ageMs: 30 },
  { runId: 'run-4', ageMs: 40 },
];

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

function metaFor(run, extra = {}) {
  const startedAt = new Date(BASE - run.ageMs).toISOString();
  return {
    runId: run.runId,
    environmentId: 'env-a',
    operation: 'prompt',
    startedAt,
    ...extra,
  };
}

function writeRun(archive, meta) {
  archive.record(meta);
  archive.append(meta.environmentId, meta.runId, {
    runId: meta.runId,
    sequence: 1,
    timestamp: meta.startedAt,
    type: 'run.started',
    payload: {},
  });
  archive.append(meta.environmentId, meta.runId, {
    runId: meta.runId,
    sequence: 2,
    timestamp: meta.startedAt,
    type: 'run.completed',
    payload: { exitCode: 0 },
  });
}

test('the archive prunes by start time, not by file name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-archive-prune-'));
  try {
    // Only `startedAt`, which is what the supervisor has always written.
    const archive = createRunArchive(dir, { maxRunsPerEnvironment: 2 });
    for (const run of REVERSED) writeRun(archive, metaFor(run));

    const restored = await archive.load();
    assert.deepEqual(
      restored.map((entry) => entry.meta.runId),
      ['run-1', 'run-0'],
      'the two newest by start time survive, oldest first',
    );

    const onDisk = (await readdir(join(dir, 'env-a'))).sort();
    assert.deepEqual(onDisk, ['run-0.json', 'run-1.json'], 'the pruned runs are deleted from disk too');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a meta that records startedAtMs sorts by it too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-archive-prune-ms-'));
  try {
    // No ISO string at all. The field the writer now records is honoured on
    // its own, so an archive written by either shape of meta prunes the same.
    const archive = createRunArchive(dir, { maxRunsPerEnvironment: 2 });
    for (const run of REVERSED) {
      const meta = metaFor(run, { startedAt: undefined, startedAtMs: BASE - run.ageMs });
      writeRun(archive, meta);
    }

    const restored = await archive.load();
    assert.deepEqual(
      restored.map((entry) => entry.meta.runId),
      ['run-1', 'run-0'],
      'the newest two survive on startedAtMs alone',
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('one archived run can be read back on demand', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-archive-read-'));
  try {
    const archive = createRunArchive(dir);
    for (const run of REVERSED) writeRun(archive, metaFor(run));

    const found = archive.readRun('run-3');
    assert.ok(found, 'the run is on disk');
    assert.equal(found.meta.environmentId, 'env-a');
    assert.deepEqual(
      found.events.map((event) => event.type),
      ['run.started', 'run.completed'],
      'its events come back with it',
    );

    assert.equal(archive.readRun('run-never-issued'), null, 'an unknown id reports nothing, like a missing file');
    assert.equal(archive.readRun('../../evil'), null, 'a hostile id reads nothing rather than escaping the directory');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('reading on demand from an archive directory that does not exist is not fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-archive-read-empty-'));
  try {
    const archive = createRunArchive(join(dir, 'never-created'));
    assert.equal(archive.readRun('run-0'), null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});