import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Tokens issued to individual paired devices — spec §8: "Device tokens are
 * bound to the device id that requested them and are revocable." Reads are
 * never cached: `cli.mjs pair revoke` runs as a separate process from the
 * long-lived Gate server, so a cache here would keep honoring a revoked
 * token until restart.
 */
export class DeviceTokenStore {
  constructor(path) {
    this.path = path;
  }

  async #readAll() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      return Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch {
      return [];
    }
  }

  async #writeAll(devices) {
    await writeFile(this.path, JSON.stringify({ devices }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  /** Issue (or reissue) a token for a device, replacing any prior one. */
  async issue(deviceId, { role, scopes }) {
    const devices = await this.#readAll();
    const token = randomBytes(32).toString('base64url');
    const next = devices.filter((entry) => entry.deviceId !== deviceId);
    next.push({ deviceId, token, role, scopes, issuedAtMs: Date.now(), revoked: false });
    await this.#writeAll(next);
    return token;
  }

  async revoke(deviceId) {
    const devices = await this.#readAll();
    let found = false;
    const next = devices.map((entry) => {
      if (entry.deviceId !== deviceId) return entry;
      found = true;
      return { ...entry, revoked: true };
    });
    if (found) await this.#writeAll(next);
    return found;
  }

  async list() {
    return this.#readAll();
  }

  /** Constant-time check against every non-revoked token on file. */
  async verify(authorizationHeader) {
    if (typeof authorizationHeader !== 'string') return null;
    const [scheme, presented] = authorizationHeader.split(' ');
    if (scheme !== 'Bearer' || !presented) return null;

    const presentedBuf = Buffer.from(presented);
    for (const entry of await this.#readAll()) {
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
