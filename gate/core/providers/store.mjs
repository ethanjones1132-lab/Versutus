import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonFile, writeFileAtomic } from '../atomic-file.mjs';
import { validateProviderRegistration } from './schema.mjs';

const CORRUPT_RETRY_MS = 25;
// `readJsonFile` reports every read failure that is not ENOENT as `corrupt`, so
// a Windows sharing violation or descriptor pressure while the writer renames
// was indistinguishable from a damaged file — and was answered the same way:
// `get()` returned null for a provider that exists, i.e. `provider_not_found`
// (the verified STORE-1 symptom), and a transient state read fell back to the
// legacy bootstrap verdict. These codes are waited out first.
const TRANSIENT_READ_CODES = new Set(['EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'EAGAIN']);
const TRANSIENT_READ_ATTEMPTS = 5;
const TRANSIENT_READ_RETRY_MS = 20;

function isTransientRead(result) {
  return result.state === 'corrupt' && TRANSIENT_READ_CODES.has(result.error?.code);
}

/**
 * A read that landed between the writer's delete and its rename used to answer
 * "provider not found" for a provider that exists, which is also how a damaged
 * registration was reported. Waiting out a transient refusal, then one retry,
 * tells the two apart: a replacement in flight resolves on a later read, a
 * damaged file does not. What is still unreadable afterwards is left on disk
 * and said out loud by name — silently answering `null` here is what turned a
 * bad file into `provider_not_found`.
 */
async function readRecord(path) {
  let result = await readJsonFile(path);
  for (let attempt = 0; attempt < TRANSIENT_READ_ATTEMPTS && isTransientRead(result); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_READ_RETRY_MS));
    result = await readJsonFile(path);
  }
  if (result.state !== 'corrupt') return result;
  await new Promise((resolve) => setTimeout(resolve, CORRUPT_RETRY_MS));
  const second = await readJsonFile(path);
  if (second.state === 'corrupt') {
    const reason = TRANSIENT_READ_CODES.has(second.error?.code)
      ? `could not be read (${second.error?.code}) even after waiting it out`
      : 'is not readable JSON';
    console.error(
      `gate: provider record ${path} ${reason}; treating it as absent and leaving it on disk (${second.error?.message})`,
    );
  }
  return second;
}

export class ProviderStore {
  constructor(gateHome) {
    this.gateHome = gateHome;
    this.configDir = join(gateHome, 'config', 'providers');
    this.stateDir = join(gateHome, 'state', 'providers');
    this.writeQueue = Promise.resolve();
    // The last state each provider's file was read as. A state read that fails
    // -- a Windows sharing violation, OneDrive holding the file -- used to be
    // answered with a fabricated legacy bootstrap, which dropped every field the
    // card is built from: `auth` became `missing` ("Set key" for a provider
    // whose key only exists in the migrated `legacyApiKeyEnv` the same unread
    // record carried) and the model list went empty. The facts are still on
    // disk, unread this once, so the ones already read stand in until they can
    // be read again.
    this.lastKnownState = new Map();
  }

  serialize(fn) {
    const result = this.writeQueue.then(fn, fn);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async list() {
    let entries;
    try {
      entries = await readdir(this.configDir);
    } catch (error) {
      // A gate home that has never had a provider is honestly empty, and ENOENT
      // is the answer for it. Any other refusal is not: an empty roster published
      // "you have no providers" with a 200, advertised no models, and said
      // nothing anywhere. The per-file reads below are retried and named; the
      // directory read is the one place a whole roster can disappear, so it is
      // reported rather than answered.
      if (error?.code === 'ENOENT') return [];
      console.error(
        `gate: provider directory ${this.configDir} could not be read (${error.code ?? error.message}); the roster is unknown, not empty`,
      );
      const failure = new Error(`provider roster could not be read: ${error.code ?? error.message}`);
      failure.code = 'provider_roster_unreadable';
      throw failure;
    }

    const records = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const record = await this.get(id);
      if (record) records.push(record);
    }
    records.sort((a, b) => a.config.id.localeCompare(b.config.id));
    return records;
  }

  async get(id) {
    const registration = await readRecord(join(this.configDir, `${id}.json`));
    if (registration.state !== 'ok') return null;
    // The filename is the canonical id -- it is what `get` is addressed by, and
    // what `list` derives before reading. Legacy v1 records carry no `id` field
    // at all, and a record that does not know its own id reaches the manifest
    // as `{ id: undefined }` and takes the whole Gate down on the first sort.
    const config = typeof registration.value.id !== 'string' || !registration.value.id
      ? { ...registration.value, id }
      : registration.value;
    // sanitized state is optional until the first check/refresh. It is read
    // through the same reader, because a state file caught mid-replace would
    // otherwise read as a live provider that suddenly claims to be legacy.
    const state = await readRecord(join(this.stateDir, `${id}.json`));
    if (state.state === 'ok') {
      this.lastKnownState.set(id, state.value);
      return { config, state: state.value };
    }
    // Absent, or unreadable after the retries above. Only the first is a real
    // "never checked", and only it gets the bootstrap verdict; the second is
    // answered from the last state this process did read for that id.
    const last = state.state === 'missing' ? undefined : this.lastKnownState.get(id);
    // A fresh object per read, as before: the fallback is handed to callers
    // that annotate the catalog, and a shared one would collect their edits.
    return { config, state: last ? { ...last } : { catalog: { source: 'legacy_bootstrap', state: 'stale', generation: 0, models: [] } } };
  }

  async put(config, state) {
    return this.serialize(async () => {
      const validation = validateProviderRegistration(config);
      if (!validation.ok) {
        throw new Error(validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '));
      }
      await mkdir(this.configDir, { recursive: true });
      await mkdir(this.stateDir, { recursive: true });
      // Each file lands on its own: temp copy, then a rename onto the live
      // path. A reader sees the old record or the new one, never neither, and a
      // kill can only orphan a temp file. The old shape deleted the live file
      // first, so every provider check and chat outcome re-entered a window
      // that answered `provider_not_found` for a provider that exists.
      await atomicWrite(join(this.configDir, `${config.id}.json`), config);
      await atomicWrite(join(this.stateDir, `${config.id}.json`), state ?? {});
      // This is now the newest state on disk, so it is what a read that fails
      // afterwards has to stand in for.
      this.lastKnownState.set(config.id, state ?? {});
      return { config, state: state ?? {} };
    });
  }

  async delete(id) {
    return this.serialize(async () => {
      await rm(join(this.configDir, `${id}.json`), { force: true });
      await rm(join(this.stateDir, `${id}.json`), { force: true });
      this.lastKnownState.delete(id);
    });
  }
}

async function atomicWrite(filePath, value) {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
}
