import { randomBytes , timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

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

    try {
      const data = await readFile(this.#path, 'utf-8');
      const parsed = JSON.parse(data);
      this.#cached = parsed.token;
      return this.#cached;
    } catch {
      return null;
    }
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

    const data = JSON.stringify({ token });
    await writeFile(this.#path, data, { mode: 0o600 });

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
