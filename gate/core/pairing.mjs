import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';

import { readJsonFile, writeFileAtomic } from './atomic-file.mjs';

// A pending list without a cap grows one entry per access request from any
// device that can reach the port; the oldest requests are the least likely
// to still be waiting on the phone, so they are the ones dropped.
const MAX_PENDING = 50;

// A read that lands while another process is mid-write can catch a truncated
// file; one short retry rides out that window before the file is called corrupt.
const CORRUPT_RETRY_MS = 25;

/**
 * Pending access requests and the operator-controlled pairing window.
 * Persisted to disk: `cli.mjs pair open|approve` runs as a separate,
 * short-lived process from the long-lived Gate server.
 *
 * Writes are atomic (tmp file + rename) and serialized through an in-process
 * promise chain, so concurrent addPending/takePending calls can no longer
 * interleave read-read-write-write and lose a request. A corrupt file is
 * moved aside as the recovery path, never overwritten in place — but only by
 * a mutating operation: the read-only paths treat it as empty, so a flood of
 * requests cannot multiply backup copies or log lines.
 */
export class PairingStore {
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

  // Read-only paths (isWindowOpen on the unauthenticated access route,
  // listPending) treat a corrupt file as empty with NO side effects: a flood
  // of requests against a corrupt file must not write unbounded backup
  // copies or log lines. Only a mutation may quarantine, and the write that
  // follows replaces the file, so the corrupt state clears itself.
  async #read() {
    const first = await readJsonFile(this.path);
    if (first.state === 'missing') return { pending: [], windowOpenUntilMs: 0 };
    if (first.state === 'corrupt') {
      await new Promise((resolve) => setTimeout(resolve, CORRUPT_RETRY_MS));
      const second = await readJsonFile(this.path);
      if (second.state === 'corrupt') {
        return { pending: [], windowOpenUntilMs: 0, corrupt: second.error };
      }
      return this.#shape(second.value);
    }
    return this.#shape(first.value);
  }

  async #readForMutation() {
    const state = await this.#read();
    if (state.corrupt) await this.#quarantineCorrupt(state.corrupt);
    return state;
  }

  #shape(parsed) {
    return {
      pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
      windowOpenUntilMs: typeof parsed?.windowOpenUntilMs === 'number' ? parsed.windowOpenUntilMs : 0,
    };
  }

  // A corrupt file must not be overwritten in place — the copy is the only
  // recovery path — so it is moved aside and the failure is logged loudly
  // before the store proceeds from empty.
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
      `Pairing store ${this.path} is unreadable (${error?.message ?? error}); `
      + `${copied ? `a copy was left at ${backup}` : 'it could not be copied'}. `
      + 'Proceeding from an empty pairing state — pending requests must be re-submitted.'
    );
  }

  async #write(state) {
    await writeFileAtomic(this.path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async isWindowOpen() {
    return Date.now() < (await this.#read()).windowOpenUntilMs;
  }

  openWindow(durationMs) {
    return this.#serialize(async () => {
      const state = await this.#readForMutation();
      state.windowOpenUntilMs = Date.now() + durationMs;
      await this.#write(state);
    });
  }

  /** Record a pending request, replacing any earlier one from the same device. */
  addPending({ deviceId, publicKeyB64Url, clientId, role, scopes }) {
    return this.#serialize(async () => {
      const state = await this.#readForMutation();
      const requestId = randomUUID();
      state.pending = state.pending.filter((entry) => entry.deviceId !== deviceId);
      state.pending.push({ requestId, deviceId, publicKeyB64Url, clientId, role, scopes, requestedAtMs: Date.now() });
      if (state.pending.length > MAX_PENDING) {
        state.pending.splice(0, state.pending.length - MAX_PENDING);
      }
      await this.#write(state);
      return requestId;
    });
  }

  async listPending() {
    return (await this.#read()).pending;
  }

  /** Remove and return a pending request by id, or null if it isn't there. */
  takePending(requestId) {
    return this.#serialize(async () => {
      const state = await this.#readForMutation();
      const index = state.pending.findIndex((entry) => entry.requestId === requestId);
      if (index === -1) return null;
      const [entry] = state.pending.splice(index, 1);
      await this.#write(state);
      return entry;
    });
  }
}
