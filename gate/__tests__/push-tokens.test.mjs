import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { access, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { PushTokenStore } from '../core/push-tokens.mjs';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-push-tokens-'));
  return {
    dir,
    path: join(dir, 'push-tokens.json'),
    tokens: new PushTokenStore(join(dir, 'push-tokens.json')),
  };
}

/**
 * Makes every read of `path` fail with `code`, the way a device that is failing
 * or a file held by another process refuses a read. Returns the function that
 * puts the real reader back.
 */
function failReads(path, code) {
  const original = fsPromises.readFile;
  fsPromises.readFile = async (target, ...rest) => {
    if (String(target) === path) {
      const error = new Error(`${code}: i/o error, read '${path}'`);
      error.code = code;
      throw error;
    }
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  return () => {
    fsPromises.readFile = original;
    syncBuiltinESMExports();
  };
}

async function quarantined(dir) {
  return (await readdir(dir)).filter((name) => name.includes('.corrupt-'));
}

test('a missing file reads as an empty store', async () => {
  const { tokens } = await store();

  assert.deepEqual(await tokens.listEnabled(), []);
  assert.equal(await tokens.get('phone-1'), null);
});

test('upsert stores one record per device id and fills defaults', async () => {
  const { tokens } = await store();

  const first = await tokens.upsert('phone-1', {
    expoPushToken: 'ExponentPushToken[first]',
    platform: 'ios',
    timezone: 'America/New_York',
  });
  const second = await tokens.upsert('phone-2', {
    expoPushToken: 'ExponentPushToken[second]',
    platform: 'android',
    timezone: 'Europe/London',
    enabled: true,
    richBody: true,
    botIds: ['bot-1'],
    quietHours: { startMinutes: 22 * 60, endMinutes: 7 * 60 },
  });

  assert.equal(first.enabled, false);
  assert.equal(first.richBody, false);
  assert.deepEqual(first.botIds, []);
  assert.equal(first.quietHours, null);
  assert.equal(typeof first.updatedAtMs, 'number');
  assert.equal(second.enabled, true);
  assert.equal(second.richBody, true);
  assert.deepEqual(second.botIds, ['bot-1']);
  assert.deepEqual(second.quietHours, { startMinutes: 1320, endMinutes: 420 });
  assert.deepEqual(await tokens.get('phone-1'), first);
  assert.deepEqual(await tokens.get('phone-2'), second);
});

test('the approval exemption default is off and persists as a boolean', async () => {
  const { tokens } = await store();

  const first = await tokens.upsert('phone-1', { expoPushToken: 'ExponentPushToken[one]' });
  assert.equal(first.quietHoursAllowApprovals, false);

  const opted = await tokens.upsert('phone-1', { quietHoursAllowApprovals: true });
  assert.equal(opted.quietHoursAllowApprovals, true);

  // A subsequent patch that does not name the field keeps the stored choice.
  const kept = await tokens.upsert('phone-1', { richBody: true });
  assert.equal(kept.quietHoursAllowApprovals, true);

  // A truthy non-boolean cannot survive — the row never carries a guess.
  const coerced = await tokens.upsert('phone-2', { expoPushToken: 'ExponentPushToken[two]', quietHoursAllowApprovals: 'yes' });
  assert.equal(coerced.quietHoursAllowApprovals, false);
});

test('upsert rotates the token for an existing device id', async () => {
  const { tokens } = await store();

  await tokens.upsert('phone-1', { expoPushToken: 'ExponentPushToken[old]' });
  await tokens.upsert('phone-1', { expoPushToken: 'ExponentPushToken[new]' });

  assert.equal((await tokens.get('phone-1'))?.expoPushToken, 'ExponentPushToken[new]');
  assert.equal((await tokens.listEnabled()).length, 0);
});

test('remove and removeByToken delete the matching row', async () => {
  const { tokens } = await store();

  await tokens.upsert('phone-1', { expoPushToken: 'ExponentPushToken[one]' });
  await tokens.upsert('phone-2', { expoPushToken: 'ExponentPushToken[two]' });

  assert.equal(await tokens.remove('phone-1'), true);
  assert.equal(await tokens.get('phone-1'), null);
  assert.equal(await tokens.removeByToken('ExponentPushToken[two]'), true);
  assert.equal(await tokens.get('phone-2'), null);
  assert.equal(await tokens.removeByToken('ExponentPushToken[missing]'), false);
});

test('enabled rows are returned without mutating the file', async () => {
  const { tokens, path } = await store();

  await tokens.upsert('phone-1', { expoPushToken: 'ExponentPushToken[one]', enabled: true });
  await tokens.upsert('phone-2', { expoPushToken: 'ExponentPushToken[two]', enabled: false });

  assert.deepEqual((await tokens.listEnabled()).map((row) => row.expoPushToken), [
    'ExponentPushToken[one]',
  ]);
  assert.deepEqual((await tokens.listEnabled()).map((row) => row.expoPushToken), [
    'ExponentPushToken[one]',
  ]);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored['phone-2']?.enabled, false);
});

test('the store writes mode 0600 and never uses a device id as a filename', async () => {
  const { tokens, dir, path } = await store();

  await tokens.upsert('../../outside', {
    expoPushToken: 'ExponentPushToken[secret]',
    platform: 'ios',
  });

  const mode = (await stat(path)).mode & 0o777;
  if (platform() !== 'win32') assert.equal(mode, 0o600);
  await assert.rejects(access(join(dir, 'outside'), 'utf8'));
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored['../../outside']?.expoPushToken, 'ExponentPushToken[secret]');
});

test('a roster that cannot be read is never written over', async () => {
  const { tokens, path, dir } = await store();
  await tokens.upsert('phone-1', { expoPushToken: 'ExponentPushToken[one]', enabled: true });
  const before = await readFile(path, 'utf8');

  const restore = failReads(path, 'EIO');
  try {
    await assert.rejects(tokens.upsert('phone-2', { expoPushToken: 'ExponentPushToken[two]' }), { code: 'EIO' });
    await assert.rejects(tokens.remove('phone-1'), { code: 'EIO' });
    await assert.rejects(tokens.removeByToken('ExponentPushToken[one]'), { code: 'EIO' });
    // Read-only callers answer as an empty roster and do not throw.
    assert.equal(await tokens.get('phone-1'), null);
    assert.deepEqual(await tokens.listEnabled(), []);
  } finally {
    restore();
  }

  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await quarantined(dir), []);
});

test('an unparseable roster is moved aside and the write starts from empty', async () => {
  const { tokens, path, dir } = await store();
  const damaged = '{"phone-1": {"expoPushToken": ';
  await writeFile(path, damaged);

  const row = await tokens.upsert('phone-2', { expoPushToken: 'ExponentPushToken[two]' });

  assert.equal(row.expoPushToken, 'ExponentPushToken[two]');
  const backups = await quarantined(dir);
  assert.equal(backups.length, 1, 'the damaged roster must be kept aside');
  assert.match(backups[0], /^push-tokens\.json\.corrupt-\d+$/);
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), damaged);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))), ['phone-2']);
});

test('reading an unparseable roster answers empty and moves nothing aside', async () => {
  const { tokens, path, dir } = await store();
  const damaged = '{"phone-1": {"expoPushToken": ';
  await writeFile(path, damaged);

  assert.deepEqual(await tokens.listEnabled(), []);
  assert.equal(await tokens.get('phone-1'), null);

  assert.deepEqual(await quarantined(dir), []);
  assert.equal(await readFile(path, 'utf8'), damaged);
});
