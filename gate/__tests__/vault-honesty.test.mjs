import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialVault } from '../core/credentials/vault.mjs';

// The vault has three answers to give about a ref: it holds a value this
// machine can read, it holds nothing, or it holds something it could not read
// or even look at. The first two used to be the only two it gave.
//
//  - `set(ref, undefined)` stored the word "undefined" (providers.auth.setApiKey
//    forwards whatever a client sent), so a missing value became a "credential".
//  - `has` answered `false` for every failure, so EACCES or EBUSY on the blob
//    was filed as "no credential" and the operator was told to set a key the
//    Gate already had.
//
// A refusal that is not ENOENT is the branch both of those take. The tests make
// each refusal deterministic and hermetic: a passthrough backend and a temp
// Gate home, no real credential store and no network.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const passthroughBackend = {
  protect: async (buffer) => buffer,
  unprotect: async (buffer) => buffer,
};

// A blob this account cannot decrypt: the same refusal DPAPI gives for a file
// written under another Windows account, produced without one.
const lockedBackend = {
  protect: async (buffer) => buffer,
  unprotect: async () => {
    throw Object.assign(new Error('DPAPI unprotect failed: the blob belongs to another account'), {
      code: 'credential_unreadable',
    });
  },
};

async function vaultFor(backend = passthroughBackend) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-vault-honesty-'));
  roots.push(gateHome);
  return { gateHome, vault: new CredentialVault({ gateHome, backend }) };
}

test('a write with no value is refused instead of storing the word undefined', async () => {
  const { gateHome, vault } = await vaultFor();
  const ref = 'provider/acme/api-key';

  for (const value of [undefined, null]) {
    await assert.rejects(
      () => vault.set(ref, value),
      (error) => {
        assert.equal(error.code, 'credential_value_missing');
        // The refusal names the ref and the shape of the value, never a value.
        assert.doesNotMatch(error.message, /secret-value/);
        return true;
      },
    );
  }

  // Nothing was written: no blob appeared, and the ref is honestly absent.
  assert.deepEqual(await readdir(join(gateHome, 'credentials')).catch(() => []), []);
  assert.equal(await vault.has(ref), false);
  assert.equal(await vault.get(ref), undefined);

  // A refused write does not replace the credential that was already there.
  await vault.set(ref, 'secret-value');
  await assert.rejects(() => vault.set(ref, undefined), (error) => error.code === 'credential_value_missing');
  assert.equal(await vault.get(ref), 'secret-value');
});

test('a presence check that fails is not answered as absent', async () => {
  const { vault } = await vaultFor();
  // A NUL in the ref is argument validation `access` refuses before it touches
  // the filesystem, on every platform — a deterministic stand-in for the
  // EACCES/EPERM/EBUSY refusals a locked blob produces.
  const ref = 'provider/acme/api\u0000key';

  await assert.rejects(
    () => vault.has(ref),
    (error) => {
      assert.notEqual(error.code, 'ENOENT');
      assert.equal(error.code, 'credential_unreadable');
      return true;
    },
  );

  const probe = await vault.inspect(ref);
  assert.equal(probe.present, true, 'a check that could not run must not be reported as a missing credential');
  assert.equal(probe.readable, false);
  assert.ok(probe.error?.code, 'the refusal is named, not flattened to a missing file');
});

test('a locked blob is present and unreadable, not an empty credential', async () => {
  const { vault } = await vaultFor(lockedBackend);
  const ref = 'provider/acme/api-key';
  await vault.set(ref, 'secret-value');

  assert.equal(await vault.has(ref), true);
  await assert.rejects(
    () => vault.get(ref),
    (error) => {
      assert.equal(error.code, 'credential_unreadable');
      return true;
    },
  );
  const probe = await vault.inspect(ref);
  assert.equal(probe.present, true);
  assert.equal(probe.readable, false);
  assert.equal(probe.error?.code, 'credential_unreadable');
});

test('an absent credential still reads as absent', async () => {
  const { vault } = await vaultFor();
  const ref = 'provider/acme/api-key';

  assert.equal(await vault.has(ref), false);
  assert.equal(await vault.get(ref), undefined);
  assert.deepEqual(await vault.inspect(ref), { present: false, readable: null });
  assert.deepEqual(await vault.describe(ref), { present: false, readable: null });
});

test('a healthy credential still round-trips and reports its status', async () => {
  const { vault } = await vaultFor();
  const ref = 'provider/acme/api-key';

  await vault.set(ref, 'secret-value');
  assert.equal(await vault.get(ref), 'secret-value');
  assert.equal(await vault.has(ref), true);
  assert.deepEqual(await vault.inspect(ref), { present: true, readable: true });

  await vault.delete(ref);
  assert.equal(await vault.has(ref), false);
  assert.equal(await vault.get(ref), undefined);
});
