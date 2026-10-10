import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The POSIX credential backends (macOS Keychain, 0600 key file).
 *
 * DPAPI seals each value with a key Windows keeps for the user. Neither macOS
 * nor Linux offers that call, so these backends keep ONE random 256-bit vault
 * key in a per-user store and seal every value with AES-256-GCM under it. The
 * vault's file layout (`<gateHome>/credentials/<ref>.<ext>`) is unchanged, so
 * has/inspect/delete keep working exactly as they do on Windows.
 *
 *   keychain  the key lives in the login Keychain, read and written only
 *             through /usr/bin/security (preferred on macOS)
 *   file      the key lives in a 0600 file inside the Gate home (fallback
 *             when there is no `security` tool, and the Linux default)
 *
 * A sealed blob names the store whose key sealed it, so a vault that switched
 * stores fails with that reason instead of a bare GCM authentication error.
 */

const MAGIC = Buffer.from('VGS1', 'ascii');
const STORE_TAGS = { keychain: 0x6b, file: 0x66 };
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + 1;

export const KEYCHAIN_SERVICE = 'com.versutus.gate';
export const KEYCHAIN_ACCOUNT = 'credential-vault-key';
// `security` documents exit 44 (errSecItemNotFound) for a missing item.
const SECURITY_NOT_FOUND = 44;

function failure(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function parseKey(text, where) {
  const hex = String(text ?? '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw failure('credential_key_corrupt', `the vault key in ${where} is not a 256-bit hex key`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Run /usr/bin/security with an argv (never a shell) and optional stdin.
 * Resolves with { code, stdout, stderr }; rejects only when it cannot start
 * or overruns its timeout.
 */
export function createSecurityRunner({ securityPath = '/usr/bin/security', spawnImpl = spawn, timeoutMs = 15000 } = {}) {
  return (args, { input } = {}) => new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnImpl(securityPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(failure('credential_keychain_timeout', `security ${args[0]} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(failure('credential_keychain_unavailable', `could not run ${securityPath}: ${error?.code ?? error?.message ?? error}`, error));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').trim(),
      });
    });
    // Always end stdin: `security -i` reads commands until EOF, and every other
    // subcommand must not sit waiting on a pipe nobody writes to.
    child.stdin?.end(input ?? '');
  });
}

/**
 * Vault key held in the login Keychain as a generic password.
 *
 * The key is written through `security -i` on stdin rather than as a
 * `-w <key>` argument, so it never appears in another process's view of our
 * argv. The item is created without -U: if a second Gate raced us and created
 * it first, the add fails and we read the winner's key back instead of
 * overwriting a key that may already seal values.
 */
export function createKeychainKeyProvider({
  runSecurity = createSecurityRunner(),
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
} = {}) {
  const where = `the login Keychain (service ${service}, account ${account})`;

  async function read() {
    const result = await runSecurity(['find-generic-password', '-s', service, '-a', account, '-w']);
    if (result.code === 0) return parseKey(result.stdout, where);
    if (result.code === SECURITY_NOT_FOUND) return null;
    throw failure(
      'credential_keychain_unavailable',
      `could not read the vault key from ${where}: ${result.stderr || `security exited ${result.code}`}`,
    );
  }

  async function create() {
    const hex = randomBytes(KEY_BYTES).toString('hex');
    const result = await runSecurity(['-i'], {
      input: `add-generic-password -s ${service} -a ${account} -l ${service}.vault -w ${hex}\n`,
    });
    // `security -i` reports a failed command on stderr but may still exit 0,
    // so the read-back is the verdict, not the exit code.
    const stored = await read();
    if (!stored) {
      throw failure(
        'credential_keychain_unavailable',
        `could not store the vault key in ${where}: ${result.stderr || `security exited ${result.code}`}`,
      );
    }
    return stored;
  }

  return {
    id: 'keychain',
    where,
    async getKey({ create: allowCreate = false } = {}) {
      const existing = await read();
      if (existing || !allowCreate) return existing;
      return create();
    },
    /** Read-only reachability check for doctor: never creates anything. */
    async reachable() {
      const result = await runSecurity(['default-keychain']);
      if (result.code !== 0) {
        throw failure('credential_keychain_unavailable', `security default-keychain failed: ${result.stderr || `exit ${result.code}`}`);
      }
      return result.stdout.trim().replace(/^"|"$/g, '');
    },
  };
}

/** Vault key in a 0600 file. Its protection is exactly that file mode. */
export function createFileKeyProvider({ keyPath }) {
  if (!keyPath) throw new Error('keyPath is required');
  const where = keyPath;

  async function read() {
    let text;
    try {
      text = await readFile(keyPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw failure('credential_key_unreadable', `could not read the vault key file ${keyPath}: ${error.message}`, error);
    }
    // A key file someone loosened is tightened back rather than trusted as is.
    const st = await stat(keyPath);
    if ((st.mode & 0o077) !== 0) await chmod(keyPath, 0o600);
    return parseKey(text, where);
  }

  return {
    id: 'file',
    where,
    async getKey({ create = false } = {}) {
      const existing = await read();
      if (existing || !create) return existing;
      await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
      const hex = randomBytes(KEY_BYTES).toString('hex');
      try {
        // 'wx': a concurrent creator wins and we read its key instead.
        await writeFile(keyPath, hex, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw failure('credential_key_unwritable', `could not create the vault key file ${keyPath}: ${error.message}`, error);
        }
      }
      return read();
    },
    async reachable() {
      return dirname(keyPath);
    },
  };
}

export function sealWithKey(key, store, plain) {
  const header = Buffer.concat([MAGIC, Buffer.from([STORE_TAGS[store]])]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
}

export function openWithKey(key, store, blob) {
  const data = Buffer.from(blob);
  if (data.length < HEADER_BYTES + IV_BYTES + TAG_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw failure('credential_unreadable', 'credential file is not a sealed vault entry (written by another backend?)');
  }
  const tag = data[MAGIC.length];
  if (tag !== STORE_TAGS[store]) {
    const sealedBy = Object.keys(STORE_TAGS).find((name) => STORE_TAGS[name] === tag) ?? 'an unknown store';
    throw failure('credential_unreadable', `credential was sealed with the ${sealedBy} vault key, but this Gate uses the ${store} store`);
  }
  const iv = data.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  const authTag = data.subarray(HEADER_BYTES + IV_BYTES, HEADER_BYTES + IV_BYTES + TAG_BYTES);
  const body = data.subarray(HEADER_BYTES + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(data.subarray(0, HEADER_BYTES));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (error) {
    throw failure('credential_unreadable', `credential did not decrypt with the ${store} vault key (key replaced?)`, error);
  }
}

/**
 * A CredentialVault backend over one key provider. protect/unprotect match the
 * DPAPI backend's contract (Buffer in, Buffer out, `credential_protect_failed`
 * / `credential_unreadable` codes on failure).
 */
export function createSealedBackend({ keyProvider }) {
  const store = keyProvider.id;
  let cachedKey = null;

  async function key({ create }) {
    if (cachedKey) return cachedKey;
    const found = await keyProvider.getKey({ create });
    if (found) cachedKey = found;
    return found;
  }

  return {
    id: store,
    fileExtension: 'sealed',
    // Sealed files are written owner-only; the directory too.
    fileMode: 0o600,
    dirMode: 0o700,
    where: keyProvider.where,
    async protect(plain) {
      let k;
      try {
        k = await key({ create: true });
      } catch (error) {
        throw failure('credential_protect_failed', `cannot save credentials: ${error.message}`, error);
      }
      return sealWithKey(k, store, Buffer.from(plain));
    },
    async unprotect(cipher) {
      let k;
      try {
        k = await key({ create: false });
      } catch (error) {
        throw failure('credential_unreadable', `cannot read credentials: ${error.message}`, error);
      }
      if (!k) throw failure('credential_unreadable', `the vault key is missing from ${keyProvider.where}`);
      return openWithKey(k, store, cipher);
    },
    /** Doctor's check: read-only (never creates a key), round-trips when it can. */
    async check() {
      try {
        const k = await keyProvider.getKey({ create: false });
        if (!k) {
          const location = await keyProvider.reachable();
          return { backend: store, ok: true, detail: `reachable (${location}); vault key is created on the first credential save` };
        }
        const probe = randomBytes(16);
        const back = openWithKey(k, store, sealWithKey(k, store, probe));
        if (!back.equals(probe)) return { backend: store, ok: false, detail: 'round-trip mismatch' };
        return { backend: store, ok: true, detail: `round-trip ok (key in ${keyProvider.where})` };
      } catch (error) {
        return { backend: store, ok: false, detail: error.message, code: error.code };
      }
    },
  };
}
