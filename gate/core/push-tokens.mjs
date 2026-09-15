import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_ROW = Object.freeze({
  enabled: false,
  richBody: false,
  botIds: [],
  quietHours: null,
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.trim().length > 0;
}

export class PushTokenStore {
  // Every mutation reads the whole file and writes a full snapshot back, so
  // two mutations in flight interleave read-read-write-write and the last write
  // resurrects what the first deleted (a notify reporting several dead tokens
  // removes them concurrently). Mutations queue here; reads stay free-running.
  #pending = Promise.resolve();

  constructor(path) {
    this.path = path;
  }

  #serialize(mutation) {
    const run = this.#pending.then(mutation, mutation);
    // Keep the queue alive when a mutation rejects; the caller still sees it.
    this.#pending = run.catch(() => {});
    return run;
  }

  async #readAll() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async #writeAll(rows) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(rows, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }

  async upsert(deviceId, patch = {}) {
    if (!validDeviceId(deviceId)) throw new Error('deviceId is required');
    if (!isRecord(patch)) throw new Error('patch must be an object');

    return this.#serialize(async () => {
      const rows = await this.#readAll();
      const existing = isRecord(rows[deviceId]) ? rows[deviceId] : {};
      const botIds = patch.botIds === undefined
        ? (Array.isArray(existing.botIds) ? existing.botIds : [])
        : Array.isArray(patch.botIds) ? patch.botIds : [];
      const quietHours = patch.quietHours === undefined
        ? (existing.quietHours ?? DEFAULT_ROW.quietHours)
        : patch.quietHours;

      const row = {
        ...DEFAULT_ROW,
        ...existing,
        ...patch,
        botIds,
        quietHours,
        updatedAtMs: Date.now(),
      };
      rows[deviceId] = row;
      await this.#writeAll(rows);
      return row;
    });
  }

  async get(deviceId) {
    if (!validDeviceId(deviceId)) return null;
    const rows = await this.#readAll();
    const row = rows[deviceId];
    return isRecord(row) ? { ...row } : null;
  }

  async listEnabled() {
    const rows = await this.#readAll();
    return Object.values(rows)
      .filter((row) => isRecord(row) && row.enabled === true)
      .map((row) => ({ ...row }));
  }

  async remove(deviceId) {
    if (!validDeviceId(deviceId)) return false;
    return this.#serialize(async () => {
      const rows = await this.#readAll();
      if (!(deviceId in rows)) return false;
      delete rows[deviceId];
      await this.#writeAll(rows);
      return true;
    });
  }

  async removeByToken(expoPushToken) {
    if (typeof expoPushToken !== 'string' || !expoPushToken) return false;
    return this.#serialize(async () => {
      const rows = await this.#readAll();
      const deviceId = Object.keys(rows).find((id) => rows[id]?.expoPushToken === expoPushToken);
      if (!deviceId) return false;
      delete rows[deviceId];
      await this.#writeAll(rows);
      return true;
    });
  }
}
