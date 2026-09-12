import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
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
