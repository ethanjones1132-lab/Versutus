import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isTransientLockError, readJsonFile, writeFileAtomic } from '../core/atomic-file.mjs';

async function makeDir() {
  return mkdtemp(join(tmpdir(), 'gate-atomic-file-'));
}

test('writeFileAtomic leaves no tmp file behind', async () => {
  const dir = await makeDir();
  try {
    const path = join(dir, 'data.json');
    await writeFileAtomic(path, JSON.stringify({ a: 1 }), { encoding: 'utf8', mode: 0o600 });

    assert.deepEqual(await readdir(dir), ['data.json']);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { a: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reader never observes a partial file while writers replace it', async () => {
  const dir = await makeDir();
  try {
    const path = join(dir, 'data.json');
    // The seed is itself a complete payload, so every state the reader can
    // observe — seed, any writer's file, or absent — is a valid verdict.
    await writeFileAtomic(path, JSON.stringify({ writer: 0, generation: 0, pad: 'x'.repeat(64 * 1024) }), 'utf8');

    // Four writers with distinct large payloads race a tight reader for
    // ~300 ms. A non-atomic write (truncate-then-write) leaves the reader a
    // truncated or empty file inside that window; an atomic one never does.
    const writers = [0, 1, 2, 3].map((writerIndex) => (async () => {
      const payload = { writer: writerIndex, generation: 0, pad: 'x'.repeat(64 * 1024) };
      const deadline = Date.now() + 300;
      let generation = 0;
      while (Date.now() < deadline) {
        payload.generation = generation;
        generation += 1;
        await writeFileAtomic(path, JSON.stringify(payload), 'utf8');
        await new Promise((resolve) => setImmediate(resolve));
      }
    })());

    const failures = [];
    const reads = { count: 0 };
    const reader = (async () => {
      const deadline = Date.now() + 300;
      while (Date.now() < deadline) {
        const result = await readJsonFile(path);
        reads.count += 1;
        // Every read is either a complete file from one writer or a missing
        // one — never a truncated, empty or mixed one.
        if (result.state !== 'ok' && result.state !== 'missing') {
          failures.push(`unexpected state ${result.state}`);
        } else if (result.state === 'ok') {
          const { writer, generation, pad } = result.value;
          if (!Number.isInteger(writer) || writer < 0 || writer > 3
            || !Number.isInteger(generation) || generation < 0
            || typeof pad !== 'string' || pad.length !== 64 * 1024) {
            failures.push('partial file observed');
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await Promise.all([...writers, reader]);

    assert.deepEqual(failures, []);
    assert.ok(reads.count > 0, 'the reader read while the writers wrote');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readJsonFile tells missing, ok and corrupt apart', async () => {
  const dir = await makeDir();
  try {
    const path = join(dir, 'data.json');

    assert.deepEqual(await readJsonFile(path), { state: 'missing' });

    await writeFileAtomic(path, JSON.stringify({ value: 42 }), 'utf8');
    assert.deepEqual(await readJsonFile(path), { state: 'ok', value: { value: 42 } });

    await writeFileAtomic(path, '{ not json', 'utf8');
    const corrupt = await readJsonFile(path);
    assert.equal(corrupt.state, 'corrupt');
    assert.ok(corrupt.error instanceof Error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a brief Windows read lock is waited out rather than called corrupt', async () => {
  const dir = await makeDir();
  const path = join(dir, 'data.json');
  await writeFileAtomic(path, JSON.stringify({ value: 1 }), 'utf8');

  const original = fsPromises.readFile;
  let refusals = 0;
  fsPromises.readFile = async (target, ...rest) => {
    if (String(target) === path && refusals < 2) {
      refusals += 1;
      const error = new Error('EBUSY: resource busy or locked');
      error.code = 'EBUSY';
      throw error;
    }
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const result = await readJsonFile(path);
    assert.equal(result.state, 'ok');
    assert.deepEqual(result.value, { value: 1 });
    assert.equal(refusals, 2);
  } finally {
    fsPromises.readFile = original;
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test('isTransientLockError names the Windows sharing-violation codes', () => {
  assert.equal(isTransientLockError({ code: 'EBUSY' }), true);
  assert.equal(isTransientLockError({ code: 'EPERM' }), true);
  assert.equal(isTransientLockError({ code: 'EACCES' }), true);
  assert.equal(isTransientLockError({ code: 'ENOENT' }), false);
  assert.equal(isTransientLockError({ code: 'EISDIR' }), false);
});
