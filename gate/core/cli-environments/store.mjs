import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateCliEnvironmentRegistration } from './schema.mjs';

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
    try {
      return JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async put(record) {
    return this.serialize(async () => {
      const validation = validateCliEnvironmentRegistration(record);
      if (!validation.ok) {
        throw new Error(validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '));
      }
      await mkdir(this.dir, { recursive: true });
      const dest = join(this.dir, `${record.id}.json`);
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
      await rm(dest, { force: true });
      await rename(tmp, dest);
      return record;
    });
  }

  async delete(id) {
    return this.serialize(async () => {
      await rm(join(this.dir, `${id}.json`), { force: true });
    });
  }
}
