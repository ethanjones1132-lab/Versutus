import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Pending access requests and the operator-controlled pairing window.
 * Persisted to disk: `cli.mjs pair open|approve` runs as a separate,
 * short-lived process from the long-lived Gate server.
 */
export class PairingStore {
  constructor(path) {
    this.path = path;
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      return {
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        windowOpenUntilMs: typeof parsed.windowOpenUntilMs === 'number' ? parsed.windowOpenUntilMs : 0,
      };
    } catch {
      return { pending: [], windowOpenUntilMs: 0 };
    }
  }

  async #write(state) {
    await writeFile(this.path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async isWindowOpen() {
    return Date.now() < (await this.#read()).windowOpenUntilMs;
  }

  async openWindow(durationMs) {
    const state = await this.#read();
    state.windowOpenUntilMs = Date.now() + durationMs;
    await this.#write(state);
  }

  /** Record a pending request, replacing any earlier one from the same device. */
  async addPending({ deviceId, publicKeyB64Url, clientId, role, scopes }) {
    const state = await this.#read();
    const requestId = randomUUID();
    state.pending = state.pending.filter((entry) => entry.deviceId !== deviceId);
    state.pending.push({ requestId, deviceId, publicKeyB64Url, clientId, role, scopes, requestedAtMs: Date.now() });
    await this.#write(state);
    return requestId;
  }

  async listPending() {
    return (await this.#read()).pending;
  }

  /** Remove and return a pending request by id, or null if it isn't there. */
  async takePending(requestId) {
    const state = await this.#read();
    const index = state.pending.findIndex((entry) => entry.requestId === requestId);
    if (index === -1) return null;
    const [entry] = state.pending.splice(index, 1);
    await this.#write(state);
    return entry;
  }
}
