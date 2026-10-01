import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWindowsDpapi } from '../core/credentials/windows-dpapi.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.pid = 4242;
  return child;
}

function fakeSpawnImpl() {
  const children = [];
  const impl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };
  impl.children = children;
  return impl;
}

test('dpapi: a child that never closes is killed and rejects dpapi_timeout', async () => {
  const spawnImpl = fakeSpawnImpl();
  const dpapi = createWindowsDpapi({ timeoutMs: 50, spawnImpl });
  await assert.rejects(
    () => dpapi.unprotect(Buffer.from('payload')),
    (error) => {
      assert.equal(error.code, 'dpapi_timeout');
      return true;
    },
  );
  assert.equal(spawnImpl.children[0].killed, true);
});

test('dpapi: a late close after the timeout is ignored (settle-once)', async () => {
  const spawnImpl = fakeSpawnImpl();
  const dpapi = createWindowsDpapi({ timeoutMs: 50, spawnImpl });
  await assert.rejects(
    () => dpapi.unprotect(Buffer.from('payload')),
    (error) => error.code === 'dpapi_timeout',
  );
  const child = spawnImpl.children[0];
  child.stdout.emit('data', Buffer.from('aGVsbG8='));
  child.emit('close', 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(child.killed, true);
});

test('dpapi: a failing unprotect rejects with credential_unreadable and the original message', async () => {
  const spawnImpl = fakeSpawnImpl();
  const dpapi = createWindowsDpapi({ timeoutMs: 5000, spawnImpl });
  const promise = dpapi.unprotect(Buffer.from('payload'));
  const child = spawnImpl.children[0];
  child.stderr.emit('data', Buffer.from('some dpapi error'));
  child.emit('close', 1);
  await assert.rejects(
    () => promise,
    (error) => {
      assert.equal(error.code, 'credential_unreadable');
      assert.match(error.message, /^DPAPI unprotect failed: /);
      assert.match(error.message, /some dpapi error/);
      return true;
    },
  );
});

test('dpapi: a failing protect rejects with credential_protect_failed', async () => {
  const spawnImpl = fakeSpawnImpl();
  const dpapi = createWindowsDpapi({ timeoutMs: 5000, spawnImpl });
  const promise = dpapi.protect(Buffer.from('payload'));
  const child = spawnImpl.children[0];
  child.stderr.emit('data', Buffer.from('boom'));
  child.emit('close', 1);
  await assert.rejects(
    () => promise,
    (error) => {
      assert.equal(error.code, 'credential_protect_failed');
      assert.match(error.message, /^DPAPI protect failed: /);
      return true;
    },
  );
});

test('dpapi: a normal run resolves with the decoded output', async () => {
  const spawnImpl = fakeSpawnImpl();
  const dpapi = createWindowsDpapi({ timeoutMs: 5000, spawnImpl });
  const promise = dpapi.unprotect(Buffer.from('payload'));
  const child = spawnImpl.children[0];
  child.stdout.emit('data', Buffer.from('aGVsbG8='));
  child.emit('close', 0);
  const result = await promise;
  assert.equal(Buffer.from(result).toString('utf8'), 'hello');
});

test('dpapi: a spawn error rejects', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    process.nextTick(() => child.emit('error', new Error('spawn failed')));
    return child;
  };
  const dpapi = createWindowsDpapi({ timeoutMs: 5000, spawnImpl });
  await assert.rejects(() => dpapi.unprotect(Buffer.from('payload')), /spawn failed/);
});

function countingBackend() {
  const calls = { protect: 0, unprotect: 0 };
  return {
    calls,
    async protect(plain) {
      calls.protect += 1;
      return Buffer.from(Buffer.from(plain).toString('base64'));
    },
    async unprotect(cipher) {
      calls.unprotect += 1;
      const decoded = Buffer.from(Buffer.from(cipher).toString('utf8'), 'base64').toString('utf8');
      if (decoded === 'FAIL') {
        throw Object.assign(new Error('DPAPI unprotect failed: simulated decrypt failure'), {
          code: 'credential_unreadable',
        });
      }
      return Buffer.from(decoded, 'utf8');
    },
  };
}

async function vaultFor(backend, options = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-vault-dpapi-'));
  roots.push(gateHome);
  return { gateHome, vault: new CredentialVault({ gateHome, backend, ...options }) };
}

async function waitFor(condition, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test('vault: 5 concurrent gets coalesce into 1 decrypt', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'secret-value');
  const results = await Promise.all([
    vault.get('provider/openai/api-key'),
    vault.get('provider/openai/api-key'),
    vault.get('provider/openai/api-key'),
    vault.get('provider/openai/api-key'),
    vault.get('provider/openai/api-key'),
  ]);
  assert.deepEqual(results, ['secret-value', 'secret-value', 'secret-value', 'secret-value', 'secret-value']);
  assert.equal(backend.calls.unprotect, 1);
});

test('vault: a second get within the TTL does not re-decrypt', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'secret-value');
  assert.equal(await vault.get('provider/openai/api-key'), 'secret-value');
  assert.equal(backend.calls.unprotect, 1);
  assert.equal(await vault.get('provider/openai/api-key'), 'secret-value');
  assert.equal(backend.calls.unprotect, 1);
});

test('vault: set invalidates the cache', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'value-one');
  assert.equal(await vault.get('provider/openai/api-key'), 'value-one');
  assert.equal(backend.calls.unprotect, 1);
  await vault.set('provider/openai/api-key', 'value-two');
  assert.equal(await vault.get('provider/openai/api-key'), 'value-two');
  assert.equal(backend.calls.unprotect, 2);
});

test('vault: a file changed on disk invalidates the cache', async () => {
  const backend = countingBackend();
  const { gateHome, vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'value-one');
  assert.equal(await vault.get('provider/openai/api-key'), 'value-one');
  assert.equal(backend.calls.unprotect, 1);
  const filePath = join(gateHome, 'credentials', 'provider-openai-api-key.dpapi');
  await writeFile(filePath, Buffer.from('value-two-much-longer').toString('base64'));
  assert.equal(await vault.get('provider/openai/api-key'), 'value-two-much-longer');
  assert.equal(backend.calls.unprotect, 2);
});

test('vault: TTL expiry re-decrypts', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend, { cacheTtlMs: 30 });
  await vault.set('provider/openai/api-key', 'secret-value');
  assert.equal(await vault.get('provider/openai/api-key'), 'secret-value');
  assert.equal(backend.calls.unprotect, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await vault.get('provider/openai/api-key'), 'secret-value');
  assert.equal(backend.calls.unprotect, 2);
});

test('vault: cacheTtlMs 0 disables the cache', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend, { cacheTtlMs: 0 });
  await vault.set('provider/openai/api-key', 'secret-value');
  assert.equal(await vault.get('provider/openai/api-key'), 'secret-value');
  assert.equal(await vault.get('provider/openai/api-key'), 'secret-value');
  assert.equal(backend.calls.unprotect, 2);
});

test('vault: a decrypt failure is not cached and is thrown with its code', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'FAIL');
  await assert.rejects(
    () => vault.get('provider/openai/api-key'),
    (error) => {
      assert.equal(error.code, 'credential_unreadable');
      assert.match(error.message, /DPAPI unprotect failed/);
      return true;
    },
  );
  assert.equal(backend.calls.unprotect, 1);
  await assert.rejects(() => vault.get('provider/openai/api-key'));
  assert.equal(backend.calls.unprotect, 2);
});

test('vault: a missing file returns undefined', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  assert.equal(await vault.get('provider/openai/api-key'), undefined);
  assert.equal(backend.calls.unprotect, 0);
});

test('vault: set is atomic — a reader loop never sees missing', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'initial');
  let sawMissing = 0;
  const reader = (async () => {
    for (let i = 0; i < 200; i += 1) {
      if (!(await vault.has('provider/openai/api-key'))) sawMissing += 1;
    }
  })();
  for (let i = 0; i < 200; i += 1) {
    await vault.set('provider/openai/api-key', `value-${i}`);
  }
  await reader;
  assert.equal(sawMissing, 0);
});

test('vault: a get issued after a set does not join a decrypt started before it', async () => {
  const backend = countingBackend();
  let releaseFirst;
  const firstDecrypt = new Promise((resolve) => { releaseFirst = resolve; });
  let slow = true;
  const inner = backend.unprotect.bind(backend);
  backend.unprotect = async (cipher) => {
    const plain = await inner(cipher);
    if (slow) {
      slow = false;
      // Self-releasing so a regression fails on the assertion instead of hanging.
      await Promise.race([firstDecrypt, new Promise((resolve) => setTimeout(resolve, 200))]);
    }
    return plain;
  };
  const { vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'value-one');
  const staleRead = vault.get('provider/openai/api-key');
  // Wait for the decrypt to actually be in flight: a fixed sleep would let a
  // slow stat/readFile land after the write, and then the stale read would
  // pick up the new value instead of the one it started from.
  await waitFor(() => backend.calls.unprotect === 1, 'the stale decrypt never started');
  await vault.set('provider/openai/api-key', 'value-two');
  assert.equal(await vault.get('provider/openai/api-key'), 'value-two');
  releaseFirst();
  assert.equal(await staleRead, 'value-one');
  // The stale decrypt must not have cached its pre-set value either.
  assert.equal(await vault.get('provider/openai/api-key'), 'value-two');
  assert.equal(backend.calls.unprotect, 2);
});

test('vault: inspect reports present and readable', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'secret-value');
  assert.deepEqual(await vault.inspect('provider/openai/api-key'), { present: true, readable: true });
});

test('vault: inspect reports present and unreadable', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  await vault.set('provider/openai/api-key', 'FAIL');
  const result = await vault.inspect('provider/openai/api-key');
  assert.equal(result.present, true);
  assert.equal(result.readable, false);
  assert.equal(result.error.code, 'credential_unreadable');
  assert.match(result.error.message, /DPAPI unprotect failed/);
});

test('vault: inspect reports missing', async () => {
  const backend = countingBackend();
  const { vault } = await vaultFor(backend);
  assert.deepEqual(await vault.inspect('provider/openai/api-key'), { present: false, readable: null });
});
