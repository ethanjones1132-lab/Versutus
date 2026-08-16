import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CredentialVault } from '../credentials/vault.mjs';
import { createWindowsDpapi } from '../credentials/windows-dpapi.mjs';

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
      backend: injectedBackend ?? createWindowsDpapi(),
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

async function readLegacyStore(root) {
  try {
    const raw = await readFile(join(root, 'secrets', 'store.enc.json'), 'utf8');
    return Object.assign(Object.create(null), JSON.parse(raw));
  } catch {
    return Object.create(null);
  }
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
