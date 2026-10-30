import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonFile } from '../atomic-file.mjs';
import { CredentialVault } from '../credentials/vault.mjs';
import { createPlatformCredentialBackend } from '../credentials/platform-backend.mjs';

const ALGORITHM = 'aes-256-gcm';
const vaults = new Map();
let injectedBackend;

const CREDENTIAL_PREFIXES = ['sk-', 'sk_', 'gsk_', 'xai-', 'ghp_', 'github_pat_'];

/**
 * A ref names a secret; it is not the secret. The vault writes each file as
 * `<ref>.dpapi`, so a ref that is itself a key puts the key in a filename —
 * which happened on 2026-08-14, into a directory that was not gitignored.
 *
 * This rejects rather than sanitizes: silently renaming a bad ref would strand
 * the secret under a name no adapter reads, trading a visible mistake for an
 * invisible one.
 */
export function looksLikeCredential(refName) {
  const value = String(refName ?? '').trim();
  if (!value) return false;
  const lowered = value.toLowerCase();
  if (CREDENTIAL_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return true;
  // A real ref is a path or a phrase; an unbroken 32+ character run is a token.
  return value.length >= 32 && !/[/\-_.:]/.test(value);
}

export function useCredentialBackend(backend) {
  injectedBackend = backend;
  vaults.clear();
}

function vaultFor(root) {
  if (!vaults.has(root)) {
    vaults.set(root, new CredentialVault({
      gateHome: root,
      backend: injectedBackend ?? createPlatformCredentialBackend({ gateHome: root }),
    }));
  }
  return vaults.get(root);
}

export async function setSecret(root, refName, value) {
  await vaultFor(root).set(refName, value);
}

export async function getSecret(root, refName) {
  const vault = vaultFor(root);
  let fromVault;
  try {
    fromVault = await vault.get(refName);
  } catch (error) {
    throw error;
  }
  if (fromVault !== undefined) return fromVault;

  const legacy = await readLegacySecret(root, refName);
  if (legacy === undefined) return undefined;
  await vault.set(refName, legacy);
  return legacy;
}

export async function listSecretNames(root) {
  const store = await readLegacyStore(root);
  return Object.keys(store);
}

export async function migrateLegacySecretsToVault(root, vault = vaultFor(root)) {
  const names = await listSecretNames(root);
  for (const name of names) {
    const value = await readLegacySecret(root, name);
    if (value === undefined) {
      throw new Error(`legacy decrypt failed for ${name}`);
    }
    await vault.set(name, value);
  }
}

/**
 * The legacy AES store predates the credential vault. A file that was never
 * written is honestly an empty store; a file that exists but cannot be read or
 * parsed is not. Answering the damaged case with `{}` made every secret it
 * still holds look absent: the migration moved nothing and reported success,
 * `listSecretNames` returned no names, and `getSecret` returned undefined for a
 * ref that was still on disk. Only ENOENT is empty; everything else throws, the
 * same distinction `readJsonFile` draws for every other store.
 */
async function readLegacyStore(root) {
  const path = join(root, 'secrets', 'store.enc.json');
  const result = await readJsonFile(path);
  if (result.state === 'missing') return Object.create(null);
  if (result.state === 'ok' && result.value && typeof result.value === 'object' && !Array.isArray(result.value)) {
    return Object.assign(Object.create(null), result.value);
  }
  const reason = result.state === 'corrupt'
    ? (result.error?.code ?? 'invalid JSON or unreadable file')
    : 'its contents are not an object of secret refs';
  const failure = new Error(`legacy secrets store ${path} is damaged (${reason}); it is not empty`);
  failure.code = 'legacy_secrets_store_unreadable';
  throw failure;
}

async function readLegacySecret(root, refName) {
  const store = await readLegacyStore(root);
  const entry = store[refName];
  if (!entry) return undefined;
  let keyHex;
  try {
    keyHex = await readFile(join(root, 'secrets', '.key'), 'utf8');
  } catch {
    throw new Error(`legacy decrypt failed for ${refName}`);
  }
  const decipher = createDecipheriv(ALGORITHM, Buffer.from(keyHex.trim(), 'hex'), Buffer.from(entry.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(entry.data, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
