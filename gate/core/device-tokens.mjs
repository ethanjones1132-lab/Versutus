import { randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFile } from 'node:fs/promises';

import { readJsonFile, writeFileAtomic } from './atomic-file.mjs';

// A read that lands while another process is mid-write can catch a truncated
// file; one short retry rides out that window before the file is called corrupt.
const CORRUPT_RETRY_MS = 25;

/**
 * Tokens issued to individual paired devices — spec §8: "Device tokens are
 * bound to the device id that requested them and are revocable." Reads are
 * never cached: `cli.mjs pair revoke` runs as a separate process from the
 * long-lived Gate server, so a cache here would keep honoring a revoked
 * token until restart.
 *
 * Writes are atomic (tmp file + rename) and serialized through an in-process
 * promise chain, so a concurrent revoke+issue can no longer interleave
 * read-read-write-write and drop a paired device. A corrupt file is never
 * overwritten in place: it is copied aside as the recovery path and the
 * mutation proceeds from an empty list, loudly.
 */
export class DeviceTokenStore {
  #chain = Promise.resolve();

  constructor(path) {
    this.path = path;
  }

  #serialize(mutation) {
    const run = this.#chain.then(mutation, mutation);
    // Keep the chain alive when a mutation rejects; the caller still sees it.
    this.#chain = run.catch(() => {});
    return run;
  }

  async #readAll() {
    const first = await readJsonFile(this.path);
    if (first.state === 'missing') return { devices: [] };
    if (first.state === 'corrupt') {
      await new Promise((resolve) => setTimeout(resolve, CORRUPT_RETRY_MS));
      const second = await readJsonFile(this.path);
      if (second.state === 'corrupt') return { devices: [], corrupt: second.error };
      return { devices: Array.isArray(second.value?.devices) ? second.value.devices : [] };
    }
    return { devices: Array.isArray(first.value?.devices) ? first.value.devices : [] };
  }

  // A corrupt file must not be overwritten in place — the copy is the only
  // recovery path — so it is moved aside and the failure is logged loudly
  // before the mutation proceeds from an empty list.
  async #quarantineCorrupt(error) {
    const backup = `${this.path}.corrupt-${Date.now()}`;
    let copied = false;
    try {
      await copyFile(this.path, backup);
      copied = true;
    } catch {
      // Best effort: the loud log below is the real signal.
    }
    console.error(
      `Device token store ${this.path} is unreadable (${error?.message ?? error}); `
      + `${copied ? `a copy was left at ${backup}` : 'it could not be copied'}. `
      + 'Proceeding from an empty device list — previously paired devices must re-pair.'
    );
  }

  /** Issue (or reissue) a token for a device, replacing any prior one. */
  issue(deviceId, { role, scopes }) {
    return this.#serialize(async () => {
      const { devices, corrupt } = await this.#readAll();
      if (corrupt) await this.#quarantineCorrupt(corrupt);
      const token = randomBytes(32).toString('base64url');
      const next = devices.filter((entry) => entry.deviceId !== deviceId);
      next.push({ deviceId, token, role, scopes, issuedAtMs: Date.now(), revoked: false });
      await writeFileAtomic(this.path, JSON.stringify({ devices: next }, null, 2), { encoding: 'utf8', mode: 0o600 });
      return token;
    });
  }

  revoke(deviceId) {
    return this.#serialize(async () => {
      const { devices, corrupt } = await this.#readAll();
      if (corrupt) await this.#quarantineCorrupt(corrupt);
      let found = false;
      const next = devices.map((entry) => {
        if (entry.deviceId !== deviceId) return entry;
        found = true;
        return { ...entry, revoked: true };
      });
      if (found) {
        await writeFileAtomic(this.path, JSON.stringify({ devices: next }, null, 2), { encoding: 'utf8', mode: 0o600 });
      }
      return found;
    });
  }

  async list() {
    return (await this.#readAll()).devices;
  }

  /** Constant-time check against every non-revoked token on file. */
  async verify(authorizationHeader) {
    if (typeof authorizationHeader !== 'string') return null;
    const [scheme, presented] = authorizationHeader.split(' ');
    if (scheme !== 'Bearer' || !presented) return null;

    const presentedBuf = Buffer.from(presented);
    for (const entry of (await this.#readAll()).devices) {
      if (entry.revoked) continue;
      const expectedBuf = Buffer.from(entry.token);
      if (expectedBuf.length !== presentedBuf.length) continue;
      if (timingSafeEqual(presentedBuf, expectedBuf)) {
        return { deviceId: entry.deviceId, role: entry.role, scopes: entry.scopes };
      }
    }
    return null;
  }
}
