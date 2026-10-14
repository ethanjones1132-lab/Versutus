// Pin for the desktop-agent registration script (../register-desktop-agent.mjs).
//
// The script exchanges a freshly generated Ed25519 device key for a bearer
// grant through /.well-known/gateway/access. That grant token is a live
// credential (terminal:use, sessions:manage), yet the script used to echo it
// into stdout — where it lands in terminal scrollback and CI logs — and to
// write its device file with the process umask, so on a shared machine every
// local account could read it. These tests spawn the real script against a
// stub grant server and prove both sides: the token reaches ONLY the device
// file (never stdout), the file keeps the full record the desktop agent
// needs, and a refusal writes no file at all.
//
// Lives under scripts/__tests__ (not gate/__tests__) because it pins a repo
// script; it runs through the same `npm run test:gate` node --test leg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..', '..');
const SCRIPT = join(SCRIPTS_DIR, '..', 'register-desktop-agent.mjs');
const DEVICE_FILE = join(REPO_ROOT, 'gate', '.grok-desktop-device.json');
const GRANT_TOKEN = 'grant-token-that-must-never-reach-stdout';

function grantServer(result) {
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function runScript(grantResult) {
  await rm(DEVICE_FILE, { force: true });
  const server = await grantServer(grantResult);
  const port = server.address().port;
  let stdout = '';
  let stderr = '';
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        env: { ...process.env, GATE_URL: `http://127.0.0.1:${port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('exit', (exitCode) => resolve(exitCode));
    });
    assert.equal(code, 0, `script exited ${code}; stderr: ${stderr}`);
    return { raw: stdout, parsed: JSON.parse(stdout) };
  } finally {
    server.close();
  }
}

test('a granted registration never prints the bearer token', async () => {
  const { raw, parsed: stdout } = await runScript({
    status: 'granted',
    requestId: 'req-1',
    token: GRANT_TOKEN,
    role: 'operator',
    scopes: ['terminal:use'],
  });
  assert.equal(stdout.status, 'granted');
  assert.equal(stdout.requestId, 'req-1');
  assert.equal(stdout.clientId, 'grok-desktop');
  assert.ok(stdout.deviceId, 'device id is still reported');
  assert.ok(!('token' in stdout), 'stdout must not carry the bearer token');
  assert.ok(!raw.includes(GRANT_TOKEN), 'raw stdout must not contain the token');
});

test('the granted token still lands in the device file, owner-only', async () => {
  await runScript({
    status: 'granted',
    requestId: 'req-2',
    token: GRANT_TOKEN,
    role: 'operator',
    scopes: ['terminal:use', 'sessions:manage'],
  });
  try {
    const raw = await readFile(DEVICE_FILE, 'utf8');
    const record = JSON.parse(raw);
    assert.equal(record.token, GRANT_TOKEN);
    assert.equal(record.clientId, 'grok-desktop');
    assert.equal(record.role, 'operator');
    assert.deepEqual(record.scopes, ['terminal:use', 'sessions:manage']);
    assert.ok(record.deviceId, 'the file keeps the device id');
    if (process.platform !== 'win32') {
      const { mode } = await stat(DEVICE_FILE);
      assert.equal(
        mode & 0o777,
        0o600,
        `device file must be owner-only, got ${(mode & 0o777).toString(8)}`,
      );
    }
  } finally {
    await rm(DEVICE_FILE, { force: true });
  }
});

test('a refused registration reports the refusal and writes no device file', async () => {
  const { parsed: stdout } = await runScript({ status: 'refused', requestId: 'req-3' });
  assert.equal(stdout.status, 'refused');
  assert.equal(stdout.requestId, 'req-3');
  await assert.rejects(readFile(DEVICE_FILE, 'utf8'), /ENOENT/);
});
