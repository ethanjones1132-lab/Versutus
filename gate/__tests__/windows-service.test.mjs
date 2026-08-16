import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTaskDefinition } from '../core/service/windows-task.mjs';
import { acquireInstanceLock } from '../core/service/instance-lock.mjs';
import { assertSafeAuthorizationUrl } from '../core/service/browser.mjs';
import { doctor } from '../core/service/doctor.mjs';

test('service installation refuses SYSTEM identity', () => {
  assert.throws(() => buildTaskDefinition({ user: 'SYSTEM' }), /logged-in user/i);
});

test('task definition binds logon of the current user', () => {
  const task = buildTaskDefinition({
    user: 'DESKTOP\\ethan',
    executable: 'C:\\Projects\\Versutus\\gate\\cli.mjs',
    gateHome: 'C:\\Users\\ethan\\AppData\\Local\\Versutus\\Gate',
  });
  assert.equal(task.logonType, 'InteractiveToken');
  assert.equal(task.runLevel, 'LeastPrivilege');
  assert.equal(task.userId, 'DESKTOP\\ethan');
  assert.match(task.command, /cli\.mjs/);
});

test('instance lock is exclusive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-lock-'));
  try {
    const first = await acquireInstanceLock(dir);
    await assert.rejects(() => acquireInstanceLock(dir), /already running|lock/i);
    await first.release();
    const second = await acquireInstanceLock(dir);
    await second.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser helper only opens validated https authorization URLs', () => {
  assert.doesNotThrow(() => assertSafeAuthorizationUrl('https://issuer.example/authorize'));
  assert.throws(() => assertSafeAuthorizationUrl('http://issuer.example/authorize'), /https/i);
  assert.throws(() => assertSafeAuthorizationUrl('file:///etc/passwd'), /https/i);
});

test('doctor reports identity, home, and listener without secrets', () => {
  const report = doctor({
    user: 'DESKTOP\\ethan',
    gateHome: 'C:\\Users\\ethan\\AppData\\Local\\Versutus\\Gate',
    listen: 'http://127.0.0.1:8760',
    pid: 4242,
  });
  assert.match(report, /DESKTOP\\ethan/);
  assert.match(report, /8760/);
  assert.equal(report.includes('token'), false);
});
