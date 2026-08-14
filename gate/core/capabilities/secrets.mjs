import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ALGORITHM = 'aes-256-gcm';

let writeQueue = Promise.resolve();
function serialize(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.catch(() => {});
  return result;
}

async function readKey(root) {
  const hex = await readFile(join(root, 'secrets', '.key'), 'utf8');
  return Buffer.from(hex.trim(), 'hex');
}

async function ensureKey(root) {
  try {
    return await readKey(root);
  } catch {
    const key = randomBytes(32);
    await mkdir(join(root, 'secrets'), { recursive: true });
    await writeFile(join(root, 'secrets', '.key'), key.toString('hex'), 'utf8');
    return key;
  }
}

async function readStore(root) {
  try {
    const raw = await readFile(join(root, 'secrets', 'store.enc.json'), 'utf8');
    return Object.assign(Object.create(null), JSON.parse(raw));
  } catch {
    return Object.create(null);
  }
}

async function writeStore(root, store) {
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'secrets', 'store.enc.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/**
 * Encrypt and persist a secret value under refName, overwriting any
 * existing value. Design spec §7: v1 tradeoff — the key lives beside the
 * ciphertext on the same disk, protecting against accidental commit/backup
 * leakage (the same threat model .env already covers), not disk compromise.
 */
export async function setSecret(root, refName, value) {
  return serialize(async () => {
    const key = await ensureKey(root);
    const store = await readStore(root);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    store[refName] = { iv: iv.toString('hex'), tag: tag.toString('hex'), data: encrypted.toString('hex') };
    await writeStore(root, store);
  });
}

/** List secret refs only. Never returns values. */
export async function listSecretNames(root) {
  const store = await readStore(root);
  return Object.keys(store);
}

/**
 * Copy each decrypted legacy secret into the DPAPI vault. Old files stay
 * until a separately approved cleanup. Fail closed: if decrypt or vault
 * write fails, throw and do not keep using the old store for that ref.
 */
export async function migrateLegacySecretsToVault(root, vault) {
  const names = await listSecretNames(root);
  for (const name of names) {
    const value = await getSecret(root, name);
    if (value === undefined) {
      throw new Error(`legacy decrypt failed for ${name}`);
    }
    await vault.set(name, value);
  }
}

/** Decrypt and return a secret value, or undefined if refName was never set. */
export async function getSecret(root, refName) {
  return serialize(async () => {
    const store = await readStore(root);
    const entry = store[refName];
    if (!entry) return undefined;
    const key = await readKey(root); // store non-empty implies key exists — set() always creates it first
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(entry.data, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  });
}
