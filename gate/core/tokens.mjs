import { randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFile } from 'node:fs/promises';

import { readJsonFile, writeFileAtomic } from './atomic-file.mjs';

export class TokenStore {
  #path;
  #cached = null;

  constructor(path) {
    this.#path = path;
  }

  async #read() {
    if (this.#cached !== null) {
      return this.#cached;
    }

    const result = await readJsonFile(this.#path);
    if (result.state === 'missing') {
      return null;
    }
    if (result.state === 'corrupt') {
      // A corrupt file means the token on the phone no longer matches anything
      // we can recover; minting a replacement is the only way forward, but it
      // must be loud and the original must survive as the recovery path.
      await this.#quarantineCorrupt(result.error);
      return null;
    }
    this.#cached = result.value.token;
    return this.#cached;
  }

  async #quarantineCorrupt(error) {
    const backup = `${this.#path}.corrupt-${Date.now()}`;
    let copied = false;
    try {
      await copyFile(this.#path, backup);
      copied = true;
    } catch {
      // Best effort: the loud log below is the real signal.
    }
    console.error(
      `Token store ${this.#path} is unreadable (${error?.message ?? error}); `
      + `${copied ? `a copy was left at ${backup}` : 'it could not be copied'}. `
      + 'Minting a new bootstrap token — the token on the phone will no longer authenticate.'
    );
  }

  async ensureToken() {
    const existing = await this.#read();
    if (existing) {
      return existing;
    }

    return this.rotate();
  }

  async rotate() {
    const bytes = randomBytes(32);
    const token = bytes.toString('base64url');

    await writeFileAtomic(this.#path, JSON.stringify({ token }), { mode: 0o600 });

    this.#cached = token;
    return token;
  }

  async verify(authorizationHeader) {
    if (!authorizationHeader || typeof authorizationHeader !== 'string') {
      return false;
    }

    const parts = authorizationHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return false;
    }

    const providedToken = parts[1];
    const expectedToken = await this.#read();

    if (!expectedToken) {
      return false;
    }

    try {
      return timingSafeEqual(
        Buffer.from(providedToken),
        Buffer.from(expectedToken)
      );
    } catch {
      return false;
    }
  }
}
