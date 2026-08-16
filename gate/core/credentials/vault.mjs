import { mkdir, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import { createWindowsDpapi } from './windows-dpapi.mjs';

export class CredentialVault {
  constructor({ gateHome, backend } = {}) {
    if (!gateHome) throw new Error('gateHome is required');
    this.gateHome = gateHome;
    this.dir = join(gateHome, 'credentials');
    this.backend = backend ?? createWindowsDpapi();
    this.writeQueue = Promise.resolve();
  }

  serialize(fn) {
    const result = this.writeQueue.then(fn, fn);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  fileFor(ref) {
    return join(this.dir, `${String(ref).replaceAll('/', '-')}.dpapi`);
  }

  async set(ref, value) {
    return this.serialize(async () => {
      const protectedValue = await this.backend.protect(Buffer.from(String(value), 'utf8'));
      await mkdir(this.dir, { recursive: true });
      const dest = this.fileFor(ref);
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, protectedValue);
      await rm(dest, { force: true });
      await rename(tmp, dest);
    });
  }

  async get(ref) {
    let cipher;
    try {
      cipher = await readFile(this.fileFor(ref));
    } catch {
      return undefined;
    }
    const plain = await this.backend.unprotect(cipher);
    return Buffer.from(plain).toString('utf8');
  }

  async delete(ref) {
    return this.serialize(async () => {
      await rm(this.fileFor(ref), { force: true });
    });
  }

  async has(ref) {
    try {
      await access(this.fileFor(ref));
      return true;
    } catch {
      return false;
    }
  }

  async describe(ref) {
    return { present: await this.has(ref) };
  }
}

export async function migrateLegacySecrets(root, vault, { getSecret, listSecretNames }) {
  const names = await listSecretNames(root);
  for (const name of names) {
    const value = await getSecret(root, name);
    if (value === undefined) {
      throw new Error(`legacy decrypt failed for ${name}`);
    }
    await vault.set(name, value);
  }
}
