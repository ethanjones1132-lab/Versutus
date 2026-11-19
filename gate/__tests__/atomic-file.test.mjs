import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isTransientLockError, readJsonFile, writeFileAtomic } from '../core/atomic-file.mjs';
import { createVoiceHandoff, HANDOFF_MAX_BYTES, HANDOFF_MAX_EXCHANGES, HANDOFF_TTL_MS } from '../core/voice/handoff.mjs';

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

const handoffScope = { backend: { kind: 'hermes' }, environmentId: 'local', botId: 'scout', sessionId: 'same-id' };

test('a voice handoff replaces its single thread file by atomic sibling rename', async (t) => {
  const gateHome = await makeDir();
  t.after(() => rm(gateHome, { recursive: true, force: true }));
  const handoff = createVoiceHandoff({ gateHome, now: () => 1 });
  const first = { user: 'old', assistant: 'first' };
  const second = { user: 'new', assistant: 'second' };
  await handoff.commit(handoffScope, first);
  const dir = join(gateHome, 'voice', 'handoff');
  const [file] = await readdir(dir);
  const target = join(dir, file);
  const rename = fsPromises.rename;
  const observations = [];
  fsPromises.rename = async (from, to) => {
    if (String(to) === target) observations.push({
      from, before: JSON.parse(await readFile(to, 'utf8')), next: JSON.parse(await readFile(from, 'utf8')),
    });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await handoff.commit(handoffScope, second);
  } finally {
    fsPromises.rename = rename;
    syncBuiltinESMExports();
  }
  assert.equal(observations.length, 1);
  assert.ok(observations[0].from.startsWith(`${target}.`));
  assert.ok(observations[0].from.endsWith('.tmp'));
  assert.deepEqual(observations[0].before, { version: 1, exchanges: [{ at: 1, ...first }] });
  assert.deepEqual(observations[0].next.exchanges, [{ at: 1, ...first }, { at: 1, ...second }]);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), observations[0].next);
  assert.deepEqual(await readdir(dir), [file]);
});

test('voice handoffs keep only the latest exchanges, cap encoded bytes, and expire each row after seven days', async (t) => {
  const gateHome = await makeDir();
  t.after(() => rm(gateHome, { recursive: true, force: true }));
  const dir = join(gateHome, 'voice', 'handoff');
  const initial = Date.now();
  let clock = initial;
  const handoff = createVoiceHandoff({ gateHome, now: () => clock });
  for (let i = 0; i < HANDOFF_MAX_EXCHANGES + 2; i++) {
    await handoff.commit(handoffScope, { user: `user-${i}`, assistant: `bot-${i}`, deviceId: 'private' });
  }
  const [file] = await readdir(dir);
  const snapshot = () => readFile(join(dir, file), 'utf8');
  const expected = Array.from({ length: HANDOFF_MAX_EXCHANGES }, (_, i) => ({
    at: initial, user: `user-${i + 2}`, assistant: `bot-${i + 2}`,
  }));
  assert.deepEqual(JSON.parse(await snapshot()), { version: 1, exchanges: expected });

  clock += 1000;
  await handoff.commit(handoffScope, { user: 'last user', assistant: 'last bot' });
  clock = initial + HANDOFF_TTL_MS;
  await handoff.sweep();
  assert.deepEqual(JSON.parse(await snapshot()).exchanges, [{ at: initial + 1000, user: 'last user', assistant: 'last bot' }]);
  assert.equal(await handoff.sendTyped({ ...handoffScope, botId: 'other' }, 'ordinary', (text) => text, () => true), 'ordinary');

  clock += 1000;
  assert.equal(await handoff.sendTyped(handoffScope, 'expired', (text) => text, () => true), 'expired');
  await handoff.sweep();
  assert.deepEqual(await readdir(dir), []);

  await handoff.commit(handoffScope, { user: '🧪'.repeat(20_000), assistant: 'a\n"'.repeat(20_000) });
  const bytes = await snapshot();
  assert.ok(Buffer.byteLength(bytes) <= HANDOFF_MAX_BYTES);
  const [large] = JSON.parse(bytes).exchanges;
  assert.match(large.user, /^(?:🧪)+$/u);
  assert.ok(large.assistant.startsWith('a\n"'));
});
