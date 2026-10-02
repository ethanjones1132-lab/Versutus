import { mkdir, readFile, rm, stat, access } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-file.mjs';
import { createWindowsDpapi } from './windows-dpapi.mjs';

// Caching a decrypted credential is safe here: the provider adapters already
// materialise the plaintext in the heap for the life of a request, so a short
// per-ref cache adds no exposure the request path does not already have. Every
// entry is keyed to the file's mtime+size and dropped on set/delete, and a
// decrypt failure is never cached.
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export class CredentialVault {
  constructor({ gateHome, backend, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {}) {
    if (!gateHome) throw new Error('gateHome is required');
    this.gateHome = gateHome;
    this.dir = join(gateHome, 'credentials');
    this.backend = backend ?? createWindowsDpapi();
    this.cacheTtlMs = cacheTtlMs;
    this.writeQueue = Promise.resolve();
    this.cache = new Map();
    this.inFlight = new Map();
    // Why the last read of a ref failed, for the refs whose file exists but
    // could not be read. A refusal is not the same answer as "no credential",
    // and reporting it as one is what made `inspect` call a locked file readable.
    this.unreadable = new Map();
  }

  serialize(fn) {
    const result = this.writeQueue.then(fn, fn);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  fileFor(ref) {
    return join(this.dir, `${String(ref).replaceAll('/', '-')}.dpapi`);
  }

  invalidate(ref) {
    this.cache.delete(ref);
    // Drop the in-flight decrypt as well: a read issued after this write must
    // not join a decrypt that started before it, and that decrypt must not
    // repopulate the cache with the value the write just replaced.
    this.inFlight.delete(ref);
    this.unreadable.delete(ref);
  }

  async set(ref, value) {
    return this.serialize(async () => {
      const protectedValue = await this.backend.protect(Buffer.from(String(value), 'utf8'));
      await mkdir(this.dir, { recursive: true });
      await writeFileAtomic(this.fileFor(ref), protectedValue);
      this.invalidate(ref);
    });
  }

  async get(ref) {
    const existing = this.inFlight.get(ref);
    if (existing) return existing.promise;
    const entry = { promise: null };
    this.inFlight.set(ref, entry);
    entry.promise = this.readThrough(ref, entry).finally(() => {
      if (this.inFlight.get(ref) === entry) this.inFlight.delete(ref);
    });
    return entry.promise;
  }

  async readThrough(ref, entry) {
    const file = this.fileFor(ref);
    let st;
    try {
      st = await stat(file);
    } catch (error) {
      this.invalidate(ref);
      // Absent is absent. Anything else — EPERM/EBUSY from the antivirus, from
      // OneDrive, or from the window between `writeFileAtomic`'s temp write and
      // its rename, all of which are routine on Windows — is a file that is
      // there and could not be read, and it used to be answered exactly like a
      // file that was never written.
      if (error?.code !== 'ENOENT') {
        this.unreadable.set(ref, error);
      }
      return undefined;
    }
    let cipher;
    try {
      cipher = await readFile(file);
    } catch (error) {
      this.invalidate(ref);
      this.unreadable.set(ref, error);
      return undefined;
    }
    this.unreadable.delete(ref);
    if (this.cacheTtlMs > 0) {
      const hit = this.cache.get(ref);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.expiresAt > Date.now()) {
        return hit.value;
      }
    }
    const plain = await this.backend.unprotect(cipher);
    const value = Buffer.from(plain).toString('utf8');
    // Only cache while this decrypt is still the ref's current one: set/delete
    // drops the in-flight entry, and a value decrypted from the pre-write file
    // must not be cached afterwards.
    if (this.cacheTtlMs > 0 && this.inFlight.get(ref) === entry) {
      this.cache.set(ref, { value, mtimeMs: st.mtimeMs, size: st.size, expiresAt: Date.now() + this.cacheTtlMs });
    }
    return value;
  }

  async delete(ref) {
    return this.serialize(async () => {
      await rm(this.fileFor(ref), { force: true });
      this.invalidate(ref);
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

  async inspect(ref) {
    const present = await this.has(ref);
    if (!present) return { present: false, readable: null };
    try {
      await this.get(ref);
      // `get` resolves undefined for a read it could not complete, so the
      // outcome has to be read back off the record of that failure: answered
      // from the resolved value alone, a locked file reported `readable: true`
      // and `service.unreadableCredential` — the one code that tells "present
      // but unusable" from "absent" — could never fire for a read failure.
      const failure = this.unreadable.get(ref);
      if (failure) {
        return { present: true, readable: false, error: { code: failure.code, message: failure.message } };
      }
      return { present: true, readable: true };
    } catch (error) {
      return { present: true, readable: false, error: { code: error.code, message: error.message } };
    }
  }

  async describe(ref) {
    const { present, readable } = await this.inspect(ref);
    return { present, readable };
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
