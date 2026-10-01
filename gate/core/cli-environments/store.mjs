import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonFile, writeFileAtomic } from '../atomic-file.mjs';
import { validateCliEnvironmentRegistration } from './schema.mjs';

const CORRUPT_RETRY_MS = 25;
// `readJsonFile` reports every read failure that is not ENOENT as `corrupt`, so
// a Windows sharing violation or descriptor pressure while the writer renames
// was indistinguishable from a damaged file — and was answered the same way:
// `get()` said "environment not found" for a record that exists, which is the
// symptom this store exists to remove. These codes are waited out first.
const TRANSIENT_READ_CODES = new Set(['EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'EAGAIN']);
const TRANSIENT_READ_ATTEMPTS = 5;
const TRANSIENT_READ_RETRY_MS = 20;

function isTransientRead(result) {
  return result.state === 'corrupt' && TRANSIENT_READ_CODES.has(result.error?.code);
}

/**
 * A read that lands on a record the writer is replacing used to answer
 * "environment not found", because the writer deleted the file first and
 * installed the new one a syscall later. It is also how a genuinely damaged
 * record was reported. Waiting out a transient refusal, then one retry, tells
 * the two apart: a replacement in flight resolves on a later read, a damaged
 * file does not. What is still unreadable afterwards is left on disk and said
 * out loud by name — a record the Gate cannot read is a record the phone was
 * told exists.
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
      `gate: environment record ${path} ${reason}; treating it as absent and leaving it on disk (${second.error?.message})`,
    );
  }
  return second;
}

export class CliEnvironmentStore {
  constructor(gateHome) {
    this.dir = join(gateHome, 'config', 'environments');
    this.writeQueue = Promise.resolve();
  }

  serialize(fn) {
    const result = this.writeQueue.then(fn, fn);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async list() {
    let entries = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const records = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const record = await this.get(name.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id) {
    const result = await readRecord(join(this.dir, `${id}.json`));
    return result.state === 'ok' ? result.value : null;
  }

  async put(record) {
    return this.serialize(async () => {
      const validation = validateCliEnvironmentRegistration(record);
      if (!validation.ok) {
        throw new Error(validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '));
      }
      await mkdir(this.dir, { recursive: true });
      // Temp-then-rename onto the live path: a kill can only orphan the temp
      // copy, and a concurrent read sees the old record or the new one — never
      // neither. The old shape (rm then rename) lost the record outright when a
      // read, a crash or a reboot landed in that window.
      await writeFileAtomic(
        join(this.dir, `${record.id}.json`),
        JSON.stringify(record, null, 2) + '\n',
        { encoding: 'utf8' },
      );
      return record;
    });
  }

  async delete(id) {
    return this.serialize(async () => {
      await rm(join(this.dir, `${id}.json`), { force: true });
    });
  }
}
