import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, chmod, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialVault } from '../core/credentials/vault.mjs';
import {
  checkCredentialBackend,
  createPlatformCredentialBackend,
  selectCredentialBackend,
} from '../core/credentials/platform-backend.mjs';
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  createFileKeyProvider,
  createKeychainKeyProvider,
  createSealedBackend,
} from '../core/credentials/sealed-backend.mjs';
import { doctor } from '../core/service/doctor.mjs';

// Every Keychain interaction in this file goes through an in-memory fake of
// /usr/bin/security. Nothing here may ever reach the real login Keychain.

/** An in-memory `security` that understands the three calls the backend makes. */
function fakeSecurity({ failAll, silentAddFailure, raceWinnerKey } = {}) {
  const items = new Map();
  const calls = [];
  const run = async (args, { input } = {}) => {
    calls.push({ args: [...args], input });
    if (failAll) return { code: 36, stdout: '', stderr: 'security: User interaction is not allowed.' };
    if (args[0] === 'find-generic-password') {
      const key = `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
      if (!items.has(key)) {
        return { code: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' };
      }
      return { code: 0, stdout: `${items.get(key)}\n`, stderr: '' };
    }
    if (args[0] === '-i') {
      const tokens = String(input).trim().split(/\s+/);
      assert.equal(tokens[0], 'add-generic-password');
      assert.ok(!tokens.includes('-U'), 'the key must never overwrite an existing item');
      const key = `${tokens[tokens.indexOf('-s') + 1]}/${tokens[tokens.indexOf('-a') + 1]}`;
      if (silentAddFailure) return { code: 0, stdout: 'security> ', stderr: 'add-generic-password: write permissions error' };
      if (raceWinnerKey) {
        // Another Gate created the item first; the add fails as a duplicate.
        items.set(key, raceWinnerKey);
        return { code: 0, stdout: '', stderr: 'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.' };
      }
      items.set(key, tokens[tokens.indexOf('-w') + 1]);
      return { code: 0, stdout: 'security> ', stderr: '' };
    }
    if (args[0] === 'default-keychain') {
      return { code: 0, stdout: '    "/Users/test/Library/Keychains/login.keychain-db"\n', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected security ${args.join(' ')}` };
  };
  return { run, calls, items };
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'gate-vault-macos-'));
}

function keychainVault(gateHome, security) {
  const backend = createPlatformCredentialBackend({
    gateHome,
    platform: 'darwin',
    env: {},
    exists: () => true,
    runSecurity: security.run,
  });
  return new CredentialVault({ gateHome, backend, cacheTtlMs: 0 });
}

test('the backend is chosen by platform, with DPAPI kept for Windows', () => {
  assert.equal(selectCredentialBackend({ platform: 'win32', env: {} }).id, 'dpapi');
  assert.equal(selectCredentialBackend({ platform: 'darwin', env: {}, exists: () => true }).id, 'keychain');
  const noTool = selectCredentialBackend({ platform: 'darwin', env: {}, exists: () => false });
  assert.equal(noTool.id, 'file');
  assert.match(noTool.reason, /security not found/);
  assert.equal(selectCredentialBackend({ platform: 'linux', env: {} }).id, 'file');
  assert.equal(selectCredentialBackend({ platform: 'darwin', env: { VERSUTUS_GATE_VAULT: 'file' }, exists: () => true }).id, 'file');
  assert.throws(
    () => selectCredentialBackend({ platform: 'darwin', env: { VERSUTUS_GATE_VAULT: 'plaintext' } }),
    /VERSUTUS_GATE_VAULT must be one of dpapi, keychain, file/,
  );
});

test('Windows still gets the DPAPI backend and the .dpapi file names it always had', async () => {
  let built = 0;
  const fakeDpapi = { protect: async (b) => Buffer.from(b), unprotect: async (b) => Buffer.from(b) };
  const backend = createPlatformCredentialBackend({
    gateHome: 'C:\\gate',
    platform: 'win32',
    env: {},
    dpapiFactory: () => { built += 1; return fakeDpapi; },
  });
  assert.equal(built, 1);
  assert.equal(backend.id, 'dpapi');
  assert.equal(backend.fileExtension, undefined);
  assert.equal(backend.fileMode, undefined, 'no POSIX file mode is forced on Windows');
  const vault = new CredentialVault({ gateHome: await tempHome(), backend });
  assert.match(vault.fileFor('openai/main'), /openai-main\.dpapi$/);
});

test('a macOS vault round-trips through a Keychain-held key, created once over stdin', async () => {
  const gateHome = await tempHome();
  const security = fakeSecurity();
  const vault = keychainVault(gateHome, security);

  await vault.set('hermes/api-key', 'sk-hermes-secret-value');
  assert.equal(await vault.get('hermes/api-key'), 'sk-hermes-secret-value');

  const adds = security.calls.filter((call) => call.args[0] === '-i');
  assert.equal(adds.length, 1, 'the vault key is created exactly once');
  for (const call of security.calls) {
    for (const arg of call.args) {
      assert.ok(!/^[0-9a-f]{64}$/i.test(arg), 'the vault key never appears in an argv');
    }
  }
  assert.ok(security.items.has(`${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`));

  // The plaintext is not on disk, and the file is owner-only.
  const file = vault.fileFor('hermes/api-key');
  assert.match(file, /hermes-api-key\.sealed$/);
  const raw = await readFile(file);
  assert.ok(!raw.toString('latin1').includes('sk-hermes-secret-value'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(gateHome, 'credentials'))).mode & 0o077, 0, 'credentials dir is owner-only');

  // A second Gate process (fresh backend) reads the same key from the Keychain.
  const second = keychainVault(gateHome, security);
  assert.equal(await second.get('hermes/api-key'), 'sk-hermes-secret-value');
  assert.equal(security.calls.filter((call) => call.args[0] === '-i').length, 1);
});

test('a racing Gate that created the Keychain key first wins; nobody overwrites it', async () => {
  const winner = 'ab'.repeat(32);
  const security = fakeSecurity({ raceWinnerKey: winner });
  const backend = createSealedBackend({ keyProvider: createKeychainKeyProvider({ runSecurity: security.run }) });
  const sealed = await backend.protect(Buffer.from('value'));
  const readerSecurity = { run: async (args) => (args[0] === 'find-generic-password' ? { code: 0, stdout: winner, stderr: '' } : { code: 1, stdout: '', stderr: '' }) };
  const reader = createSealedBackend({ keyProvider: createKeychainKeyProvider({ runSecurity: readerSecurity.run }) });
  assert.equal(Buffer.from(await reader.unprotect(sealed)).toString('utf8'), 'value');
});

test('a Keychain that refuses is a visible failure on save and on read, never a silent undefined', async () => {
  const gateHome = await tempHome();
  const vault = keychainVault(gateHome, fakeSecurity({ failAll: true }));
  await assert.rejects(vault.set('hermes/api-key', 'x'), (error) => {
    assert.equal(error.code, 'credential_protect_failed');
    assert.match(error.message, /login Keychain/);
    assert.match(error.message, /User interaction is not allowed/);
    return true;
  });

  // A value sealed earlier (by a working Keychain) must not read back as absent.
  const working = fakeSecurity();
  await keychainVault(gateHome, working).set('hermes/api-key', 'x');
  await assert.rejects(vault.get('hermes/api-key'), (error) => error.code === 'credential_unreadable');
  const inspected = await vault.inspect('hermes/api-key');
  assert.equal(inspected.present, true);
  assert.equal(inspected.readable, false);
});

test('an add that `security -i` reports only on stderr is caught by the read-back', async () => {
  const vault = keychainVault(await tempHome(), fakeSecurity({ silentAddFailure: true }));
  await assert.rejects(vault.set('k', 'v'), /could not store the vault key in the login Keychain .*: add-generic-password: write permissions error/);
});

test('the file store keeps its key 0600, tightens a loosened key, and round-trips', async () => {
  const gateHome = await tempHome();
  const backend = createPlatformCredentialBackend({ gateHome, platform: 'linux', env: {} });
  assert.equal(backend.id, 'file');
  const vault = new CredentialVault({ gateHome, backend, cacheTtlMs: 0 });
  await vault.set('openai/main', 'sk-file-store');
  assert.equal(await vault.get('openai/main'), 'sk-file-store');

  const keyPath = join(gateHome, 'credentials', '.vault-key');
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  await chmod(keyPath, 0o644);
  const reopened = new CredentialVault({
    gateHome,
    backend: createPlatformCredentialBackend({ gateHome, platform: 'linux', env: {} }),
    cacheTtlMs: 0,
  });
  assert.equal(await reopened.get('openai/main'), 'sk-file-store');
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600, 'a loosened key file is tightened back');
  const names = await readdir(join(gateHome, 'credentials'));
  assert.deepEqual(names.sort(), ['.vault-key', 'openai-main.sealed']);
});

test('a value sealed under one store names the mismatch instead of a bare decrypt error', async () => {
  const gateHome = await tempHome();
  const keychainBackend = createSealedBackend({ keyProvider: createKeychainKeyProvider({ runSecurity: fakeSecurity().run }) });
  const sealed = await keychainBackend.protect(Buffer.from('v'));
  const fileBackend = createSealedBackend({ keyProvider: createFileKeyProvider({ keyPath: join(gateHome, 'k') }) });
  await fileBackend.protect(Buffer.from('creates the file key'));
  await assert.rejects(fileBackend.unprotect(sealed), /sealed with the keychain vault key, but this Gate uses the file store/);
  await assert.rejects(fileBackend.unprotect(Buffer.from('legacy dpapi bytes')), /not a sealed vault entry/);
});

test('a corrupt key file fails loudly rather than sealing with garbage', async () => {
  const gateHome = await tempHome();
  const keyPath = join(gateHome, 'credentials', '.vault-key');
  const backend = createPlatformCredentialBackend({ gateHome, platform: 'linux', env: {} });
  await backend.protect(Buffer.from('x'));
  await writeFile(keyPath, 'not-a-key', { mode: 0o600 });
  const fresh = createPlatformCredentialBackend({ gateHome, platform: 'linux', env: {} });
  await assert.rejects(fresh.protect(Buffer.from('y')), /not a 256-bit hex key/);
});

test('doctor check is read-only before the first save and a real round-trip after', async () => {
  const gateHome = await tempHome();
  const security = fakeSecurity();
  const backend = createPlatformCredentialBackend({ gateHome, platform: 'darwin', env: {}, exists: () => true, runSecurity: security.run });

  const before = await checkCredentialBackend(backend);
  assert.equal(before.backend, 'keychain');
  assert.equal(before.ok, true);
  assert.match(before.detail, /created on the first credential save/);
  assert.equal(security.calls.filter((call) => call.args[0] === '-i').length, 0, 'doctor must not create a key');

  await backend.protect(Buffer.from('first save'));
  const after = await checkCredentialBackend(backend);
  assert.equal(after.ok, true);
  assert.match(after.detail, /round-trip ok/);

  const broken = createPlatformCredentialBackend({
    gateHome, platform: 'darwin', env: {}, exists: () => true, runSecurity: fakeSecurity({ failAll: true }).run,
  });
  const failed = await checkCredentialBackend(broken);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /User interaction is not allowed/);
});

test('a backend without its own check (DPAPI) is checked by a real round-trip', async () => {
  const good = { id: 'dpapi', protect: async (b) => Buffer.from(b).reverse(), unprotect: async (b) => Buffer.from(b).reverse() };
  assert.deepEqual(await checkCredentialBackend(good), { backend: 'dpapi', ok: true, detail: 'round-trip ok' });
  const bad = {
    id: 'dpapi',
    protect: async () => { throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }); },
    unprotect: async () => Buffer.alloc(0),
  };
  const result = await checkCredentialBackend(bad);
  assert.equal(result.ok, false);
  assert.match(result.detail, /powershell\.exe ENOENT/);
});

test('doctor reports the real vault check instead of a hard-coded dpapi line', () => {
  const ok = doctor({ user: 'ethan', gateHome: '/g', listen: 'http://127.0.0.1:8090', vaultCheck: { backend: 'keychain', ok: true, detail: 'round-trip ok' } });
  assert.match(ok, /^credentials: keychain usable \(round-trip ok\)$/m);
  assert.doesNotMatch(ok, /dpapi: usable/);
  const bad = doctor({ user: 'ethan', gateHome: '/g', listen: 'x', vaultCheck: { backend: 'dpapi', ok: false, detail: 'spawn powershell.exe ENOENT' } });
  assert.match(bad, /^credentials: dpapi UNAVAILABLE \(spawn powershell\.exe ENOENT\)$/m);
  assert.match(doctor({ user: 'u', gateHome: '/g', listen: 'x' }), /^credentials: not checked$/m);
});
