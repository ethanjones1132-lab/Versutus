import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ALGORITHM = 'aes-256-gcm';

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
    return JSON.parse(raw);
  } catch {
    return {};
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
  const key = await ensureKey(root);
  const store = await readStore(root);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  store[refName] = { iv: iv.toString('hex'), tag: tag.toString('hex'), data: encrypted.toString('hex') };
  await writeStore(root, store);
}

/** Decrypt and return a secret value, or undefined if refName was never set. */
export async function getSecret(root, refName) {
  const store = await readStore(root);
  const entry = store[refName];
  if (!entry) return undefined;
  const key = await readKey(root); // store non-empty implies key exists — set() always creates it first
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(entry.data, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
