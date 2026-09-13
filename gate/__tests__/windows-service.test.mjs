import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTaskDefinition, writeTaskFile } from '../core/service/windows-task.mjs';
import { acquireInstanceLock } from '../core/service/instance-lock.mjs';
import { assertSafeAuthorizationUrl } from '../core/service/browser.mjs';
import { doctor } from '../core/service/doctor.mjs';

test('service installation refuses SYSTEM identity', () => {
  assert.throws(() => buildTaskDefinition({ user: 'SYSTEM' }), /logged-in user/i);
});

test('task definition binds logon of the current user', () => {
  const task = buildTaskDefinition({
    user: 'DESKTOP\\ethan',
    codeRoot: 'C:\\Projects\\Versutus',
  });
  assert.equal(task.name, 'VersutusGate');
  assert.equal(task.logonType, 'InteractiveToken');
  assert.equal(task.runLevel, 'LeastPrivilege');
  assert.equal(task.userId, 'DESKTOP\\ethan');
});

test('task XML runs the supervisor headless from the code root', () => {
  const task = buildTaskDefinition({
    user: 'ETHANSPC\\ethan',
    codeRoot: 'C:\\Projects\\Versutus',
  });
  assert.match(task.xml, /http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task/);
  assert.match(task.xml, /<UserId>ETHANSPC\\ethan<\/UserId>/);
  assert.match(task.xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(task.xml, /<Command>C:\\Windows\\System32\\conhost\.exe<\/Command>/);
  assert.match(task.xml, /service run/);
  assert.match(task.xml, /<WorkingDirectory>C:\\Projects\\Versutus<\/WorkingDirectory>/);
  assert.match(task.xml, /<Interval>PT5M<\/Interval>/);
  assert.match(task.xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task.xml, /<Priority>5<\/Priority>/);
  assert.match(task.xml, /<LogonTrigger>/);
});

test('task XML escapes user-controlled values', () => {
  const task = buildTaskDefinition({ user: 'A&B\\"<>', codeRoot: 'C:\\R&D' });
  assert.doesNotMatch(task.xml, /A&B/);
  assert.match(task.xml, /A&amp;B/);
});

test('task file is written UTF-16LE with a BOM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-task-'));
  try {
    const task = buildTaskDefinition({ user: 'ETHANSPC\\ethan' });
    const dest = join(dir, 'VersutusGate.xml');
    writeTaskFile(task.xml, dest);
    const bytes = readFileSync(dest);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xfe);
    assert.match(bytes.toString('utf16le'), /<Task version="1\.2"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  });
  assert.match(report, /DESKTOP\\ethan/);
  assert.match(report, /8760/);
  assert.doesNotMatch(report, /\bpid\b/i);
  assert.equal(report.includes('token'), false);
});
