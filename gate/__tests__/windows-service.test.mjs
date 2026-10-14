import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTaskDefinition, taskRunArgs, writeTaskFile } from '../core/service/windows-task.mjs';
import { acquireInstanceLock } from '../core/service/instance-lock.mjs';
import { assertSafeAuthorizationUrl } from '../core/service/browser.mjs';
import { doctor } from '../core/service/doctor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'cli.mjs');

/** Run the real CLI with a substituted environment, as the driver's shell would. */
async function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [cliPath, ...args], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

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
  assert.match(task.xml, /<StartBoundary>/);
  assert.match(task.xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task.xml, /<Priority>5<\/Priority>/);
  assert.match(task.xml, /<LogonTrigger>/);
});

test('task XML escapes user-controlled values', () => {
  const task = buildTaskDefinition({ user: 'A&B\\"<>', codeRoot: 'C:\\R&D' });
  assert.doesNotMatch(task.xml, /A&B/);
  assert.match(task.xml, /A&amp;B/);
});

test('a task definition names the host and port its installer resolved', () => {
  const task = buildTaskDefinition({
    user: 'ETHANSPC\\ethan',
    codeRoot: 'C:\\Projects\\Versutus',
    host: '0.0.0.0',
    port: 9500,
  });
  assert.match(task.xml, /service run --host 0\.0\.0\.0 --port 9500/);
  // An install with no flags is unchanged: the Gate's own defaults still apply.
  const plain = buildTaskDefinition({ user: 'ETHANSPC\\ethan' });
  assert.doesNotMatch(plain.xml, /--host|--port/);
});

test('an installed task reads its supervisor host and port back', () => {
  const task = buildTaskDefinition({ user: 'ETHANSPC\\ethan', host: '127.0.0.1', port: 9500 });
  assert.deepEqual(taskRunArgs(task.xml), { host: '127.0.0.1', port: 9500 });
  // The flags are independent, and anything absent means the Gate's default.
  assert.deepEqual(taskRunArgs(buildTaskDefinition({ user: 'ETHANSPC\\ethan', port: 9000 }).xml), { port: 9000 });
  assert.deepEqual(taskRunArgs(buildTaskDefinition({ user: 'ETHANSPC\\ethan' }).xml), {});
  assert.deepEqual(taskRunArgs(''), {});
});

test('a malformed install flag is refused before anything is written', { skip: process.platform !== 'win32' }, async () => {
  const { code, stderr } = await runCli(['service', 'install', '--host', 'not-an-ip']);
  assert.equal(code, 1);
  assert.match(stderr, /--host expects an IP address/);
});

test('a dry-run install writes no task file and names what it would register', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-service-dry-run-'));
  try {
    const { code, stdout, stderr } = await runCli(
      ['service', 'install', '--dry-run', '--host', '0.0.0.0', '--port', '9500'],
      { VERSUTUS_GATE_HOME: dir },
    );
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Dry run: nothing written, nothing registered/);
    const xmlPath = join(dir, 'service', 'VersutusGate.xml');
    assert.ok(stdout.includes(`Would write ${xmlPath}`), stdout);
    assert.match(stdout, /service run --host 0\.0\.0\.0 --port 9500/);
    assert.ok(stdout.includes(`schtasks /Create /TN VersutusGate /XML "${xmlPath}" /F`), stdout);
    assert.ok(stdout.includes('schtasks /Run /TN VersutusGate'), stdout);
    assert.equal(existsSync(join(dir, 'service')), false, 'dry run wrote the task file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('service status probes the port the installed task names', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-service-status-'));
  // The listener stands in for a Gate installed on a named port, and answers
  // 500: only a probe of THAT port can report "listener responded 500", while
  // the old hard-coded 8760 would answer 200 (a real Gate) or refuse.
  const server = createServer((request, response) => {
    response.writeHead(500);
    response.end('not a Gate');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    const serviceDir = join(dir, 'service');
    await mkdir(serviceDir, { recursive: true });
    writeTaskFile(
      buildTaskDefinition({ user: 'ETHANSPC\\ethan', codeRoot: 'C:\\Projects\\Versutus', host: '127.0.0.1', port }).xml,
      join(serviceDir, 'VersutusGate.xml'),
    );
    await writeFile(join(serviceDir, 'supervisor.json'), JSON.stringify({ status: 'running' }));

    const { code, stdout, stderr } = await runCli(['service', 'status'], { VERSUTUS_GATE_HOME: dir });
    assert.match(`${stdout}\n${stderr}`, /UNREACHABLE \(listener responded 500\)/);
    assert.equal(code, 1);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
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
