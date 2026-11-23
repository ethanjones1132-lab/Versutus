import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PairingStore } from '../core/pairing.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gateDir = join(__dirname, '..');

// `handlePair` reads and writes the stores beside the CLI it runs from, so a
// throwaway copy of the CLI (plus the core it imports) IS the temp pairing
// store for these tests. The repo's real gate/.pairing.json is never touched.
let cliRoot;

before(async () => {
  cliRoot = await mkdtemp(join(tmpdir(), 'gate-cli-pair-'));
  // The same set `cli-start-preflight` copies: the CLI's top-level imports
  // reach `core` (which imports `flavors`) and the kind/registry lookups.
  for (const entry of ['cli.mjs', 'core', 'flavors', 'registry']) {
    await cp(join(gateDir, entry), join(cliRoot, entry), { recursive: true });
  }
});

beforeEach(async () => {
  await rm(join(cliRoot, '.pairing.json'), { force: true });
  await rm(join(cliRoot, '.device-tokens.json'), { force: true });
});

after(async () => {
  await rm(cliRoot, { recursive: true, force: true });
});

function runCli(args) {
  return new Promise((resolve) => {
    const proc = spawn('node', [join(cliRoot, 'cli.mjs'), ...args], {
      cwd: cliRoot,
      env: { ...process.env, VERSUTUS_GATE_HOME: join(cliRoot, 'home') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function addPending({ deviceId, role = 'operator', scopes = ['chat:send', 'chat:read'] }) {
  const pairing = new PairingStore(join(cliRoot, '.pairing.json'));
  return pairing.addPending({
    deviceId,
    publicKeyB64Url: `public-key-for-${deviceId}`,
    clientId: `${deviceId}-client`,
    role,
    scopes,
  });
}

function deviceStore() {
  return new DeviceTokenStore(join(cliRoot, '.device-tokens.json'));
}

const APPROVED_LINE = 'Approved device phone-1. The phone collects its token through its signed status request; none is printed here.\n';

test('pair approve confirms the device without printing its token', async () => {
  const requestId = await addPending({ deviceId: 'phone-1' });
  const result = await runCli(['pair', 'approve', requestId]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, APPROVED_LINE, 'approval prints only the device, no token line');
  assert.doesNotMatch(result.stdout, /Token:/, 'no token line may reappear on stdout');

  // The token is still issued — the phone fetches it through the signed
  // status route — so the assertion above is about stdout, not the store.
  const devices = await deviceStore().list();
  assert.equal(devices.length, 1);
  const issued = devices[0].token;
  assert.ok(typeof issued === 'string' && issued.length > 0, 'approving still issues a token');
  assert.ok(!result.stdout.includes(issued), 'the issued token must never appear on stdout');
  assert.ok(!result.stdout.includes(issued.slice(0, 8)), 'not even a token prefix may be printed');
  assert.ok(!result.stderr.includes(issued), 'the issued token must never appear on stderr');
});

test('pair approve records the requested role and scopes and consumes the request', async () => {
  const requestId = await addPending({ deviceId: 'phone-2', role: 'viewer', scopes: ['chat:read'] });
  const result = await runCli(['pair', 'approve', requestId]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Approved device phone-2\./);
  const devices = await deviceStore().list();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceId, 'phone-2');
  assert.equal(devices[0].role, 'viewer');
  assert.deepEqual(devices[0].scopes, ['chat:read']);
  assert.equal(devices[0].revoked, false);

  const pending = await new PairingStore(join(cliRoot, '.pairing.json')).listPending();
  assert.equal(pending.length, 0, 'approving consumes the pending request');
});

test('pair approve still explains a missing id and an unknown request', async () => {
  const missingId = await runCli(['pair', 'approve']);
  assert.equal(missingId.code, 1);
  assert.match(missingId.stderr, /Usage: node gate\/cli\.mjs pair approve <requestId>/);
  assert.equal(missingId.stdout, '');

  const unknown = await runCli(['pair', 'approve', 'no-such-request']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /No pending request "no-such-request"/);
  assert.equal(unknown.stdout, '');

  assert.deepEqual(await deviceStore().list(), [], 'a refused approval issues no token');
});

test('pair revoke output is unchanged', async () => {
  const requestId = await addPending({ deviceId: 'phone-3' });
  const approved = await runCli(['pair', 'approve', requestId]);
  assert.equal(approved.code, 0, approved.stderr);

  const revoked = await runCli(['pair', 'revoke', 'phone-3']);
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.equal(revoked.stdout, 'Revoked device phone-3.\n');

  // Revoking keeps the record and marks it revoked, so a second revoke finds it
  // and repeats the same line. This run changes only approve's stdout; pin the
  // existing behaviour rather than the message a removal would print.
  const again = await runCli(['pair', 'revoke', 'phone-3']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, 'Revoked device phone-3.\n');
});

test('pair list output is unchanged', async () => {
  const pendingId = await addPending({ deviceId: 'phone-pending', role: 'viewer' });
  const approvedId = await addPending({ deviceId: 'phone-paired' });
  const approved = await runCli(['pair', 'approve', approvedId]);
  assert.equal(approved.code, 0, approved.stderr);

  const result = await runCli(['pair', 'list']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`  ${pendingId}  device=phone-pending  role=viewer`));
  assert.match(result.stdout, /Paired devices:\n  phone-paired  role=operator/);
});

test('CLI help describes approve without promising a printed token', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /approve <requestId> Approve a pending access request; the phone/);
  assert.match(stdout, /collects its own token, nothing is printed/);
  assert.doesNotMatch(stdout, /Token:/, 'help must not promise a printed token');
});
