import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readJsonFile, writeFileAtomic } from './atomic-file.mjs';

// A read that lands while another process is mid-write can catch a truncated
// file; one short retry rides out that window before the file is called corrupt.
const CORRUPT_RETRY_MS = 25;

const DEFAULT_ROW = Object.freeze({
  enabled: false,
  richBody: false,
  botIds: [],
  quietHours: null,
  quietHoursAllowApprovals: false,
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
    const first = await readJsonFile(this.path);
    if (first.state === 'corrupt') {
      await new Promise((resolve) => setTimeout(resolve, CORRUPT_RETRY_MS));
      const second = await readJsonFile(this.path);
      if (second.state === 'ok') return isRecord(second.value) ? second.value : {};
      return {};
    }
    if (first.state === 'missing') return {};
    return isRecord(first.value) ? first.value : {};
  }

  async #writeAll(rows) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomic(this.path, `${JSON.stringify(rows, null, 2)}\n`, {
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
      const quietHoursAllowApprovals = patch.quietHoursAllowApprovals === undefined
        ? existing.quietHoursAllowApprovals === true
        : patch.quietHoursAllowApprovals === true;

      const row = {
        ...DEFAULT_ROW,
        ...existing,
        ...patch,
        botIds,
        quietHours,
        quietHoursAllowApprovals,
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
