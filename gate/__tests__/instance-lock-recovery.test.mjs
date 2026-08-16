import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireInstanceLock } from '../core/service/instance-lock.mjs';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-lock-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A hard kill (Stop-Process, a crash, a power cut) never runs the exit handler
 * that releases the lock. Without recovery the Gate refuses to start until an
 * operator deletes the file by hand — a papercut that reads as "the Gate is
 * broken" long after the process that wrote the lock is gone.
 */
test('a lock left by a dead process is reclaimed', async () => {
  await withHome(async (dir) => {
    // A pid that cannot be running: writeFile then never release, as a crash would.
    await writeFile(
      join(dir, 'gate.lock'),
      JSON.stringify({ pid: 0x7ffffffe, at: new Date().toISOString() }),
      'utf8',
    );

    const lock = await acquireInstanceLock(dir);
    const written = JSON.parse(await readFile(join(dir, 'gate.lock'), 'utf8'));
    assert.equal(written.pid, process.pid, 'the reclaiming process should own the lock');
    await lock.release();
  });
});

test('a lock held by a live process is still refused', async () => {
  await withHome(async (dir) => {
    const first = await acquireInstanceLock(dir);
    await assert.rejects(() => acquireInstanceLock(dir), /already running/i);
    await first.release();
    const second = await acquireInstanceLock(dir);
    await second.release();
  });
});

test('an unreadable or truncated lock file is reclaimed rather than trusted', async () => {
  await withHome(async (dir) => {
    // A crash mid-write leaves a lock with no usable pid; refusing forever on
    // unparseable bytes is the same trap as refusing on a dead pid.
    await writeFile(join(dir, 'gate.lock'), '{ not json', 'utf8');
    const lock = await acquireInstanceLock(dir);
    await lock.release();
  });
});

test('releasing twice does not throw', async () => {
  await withHome(async (dir) => {
    const lock = await acquireInstanceLock(dir);
    await lock.release();
    await lock.release();
  });
});
