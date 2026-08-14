import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateProviderRegistration } from './schema.mjs';

export class ProviderStore {
  constructor(gateHome) {
    this.gateHome = gateHome;
    this.configDir = join(gateHome, 'config', 'providers');
    this.stateDir = join(gateHome, 'state', 'providers');
    this.writeQueue = Promise.resolve();
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
    } catch {
      return [];
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
    let config;
    try {
      config = JSON.parse(await readFile(join(this.configDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
    let state = { catalog: { source: 'legacy_bootstrap', state: 'stale', generation: 0, models: [] } };
    try {
      state = JSON.parse(await readFile(join(this.stateDir, `${id}.json`), 'utf8'));
    } catch {
      // sanitized state is optional until the first check/refresh
    }
    return { config, state };
  }

  async put(config, state) {
    return this.serialize(async () => {
      const validation = validateProviderRegistration(config);
      if (!validation.ok) {
        throw new Error(validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '));
      }
      await mkdir(this.configDir, { recursive: true });
      await mkdir(this.stateDir, { recursive: true });
      await atomicWrite(join(this.configDir, `${config.id}.json`), config);
      await atomicWrite(join(this.stateDir, `${config.id}.json`), state ?? {});
      return { config, state: state ?? {} };
    });
  }

  async delete(id) {
    return this.serialize(async () => {
      await rm(join(this.configDir, `${id}.json`), { force: true });
      await rm(join(this.stateDir, `${id}.json`), { force: true });
    });
  }
}

async function atomicWrite(filePath, value) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rm(filePath, { force: true });
  await rename(tmp, filePath);
}
