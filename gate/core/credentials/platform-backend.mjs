import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createWindowsDpapi } from './windows-dpapi.mjs';
import {
  createFileKeyProvider,
  createKeychainKeyProvider,
  createSealedBackend,
  createSecurityRunner,
} from './sealed-backend.mjs';

export const VAULT_BACKENDS = ['dpapi', 'keychain', 'file'];
const SECURITY_PATH = '/usr/bin/security';

/**
 * Which credential backend this platform uses.
 *
 *   win32   dpapi (unchanged)
 *   darwin  keychain via /usr/bin/security; the 0600 key file when the tool
 *           is absent
 *   other   the 0600 key file
 *
 * VERSUTUS_GATE_VAULT=dpapi|keychain|file overrides the choice, e.g. a Mac
 * Gate run where the login Keychain is locked (an SSH session) can opt into
 * the file store explicitly. There is deliberately no silent runtime fallback
 * from keychain to file: values sealed under one key are unreadable under the
 * other, so a store that fails must fail loudly, not switch.
 */
export function selectCredentialBackend({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  securityPath = SECURITY_PATH,
} = {}) {
  const override = typeof env.VERSUTUS_GATE_VAULT === 'string' ? env.VERSUTUS_GATE_VAULT.trim().toLowerCase() : '';
  if (override) {
    if (!VAULT_BACKENDS.includes(override)) {
      throw Object.assign(
        new Error(`VERSUTUS_GATE_VAULT must be one of ${VAULT_BACKENDS.join(', ')} (got "${env.VERSUTUS_GATE_VAULT}")`),
        { code: 'credential_backend_invalid' },
      );
    }
    return { id: override, reason: 'VERSUTUS_GATE_VAULT' };
  }
  if (platform === 'win32') return { id: 'dpapi', reason: 'windows' };
  if (platform === 'darwin') {
    return exists(securityPath)
      ? { id: 'keychain', reason: 'macos' }
      : { id: 'file', reason: `${securityPath} not found` };
  }
  return { id: 'file', reason: platform };
}

export function createPlatformCredentialBackend({
  gateHome,
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  securityPath = SECURITY_PATH,
  runSecurity,
  dpapiFactory = createWindowsDpapi,
} = {}) {
  const selected = selectCredentialBackend({ platform, env, exists, securityPath });
  if (selected.id === 'dpapi') {
    return Object.assign(dpapiFactory(), { id: 'dpapi', selectedBecause: selected.reason });
  }
  if (selected.id === 'keychain') {
    const backend = createSealedBackend({
      keyProvider: createKeychainKeyProvider({ runSecurity: runSecurity ?? createSecurityRunner({ securityPath }) }),
    });
    return Object.assign(backend, { selectedBecause: selected.reason });
  }
  if (!gateHome) throw new Error('gateHome is required for the file credential store');
  const backend = createSealedBackend({
    keyProvider: createFileKeyProvider({ keyPath: join(gateHome, 'credentials', '.vault-key') }),
  });
  return Object.assign(backend, { selectedBecause: selected.reason });
}

/**
 * A real check of the vault backend for `doctor`, replacing the old hard-coded
 * `dpapi: usable`. Backends with their own read-only check use it; anything
 * else (DPAPI) gets a protect/unprotect round-trip of a throwaway probe, which
 * writes nothing to disk.
 */
export async function checkCredentialBackend(backend) {
  const id = backend?.id ?? 'custom';
  if (!backend) return { backend: id, ok: false, detail: 'no credential backend' };
  if (typeof backend.check === 'function') return backend.check();
  try {
    const probe = randomBytes(16);
    const back = Buffer.from(await backend.unprotect(await backend.protect(probe)));
    return back.equals(probe)
      ? { backend: id, ok: true, detail: 'round-trip ok' }
      : { backend: id, ok: false, detail: 'round-trip mismatch' };
  } catch (error) {
    return { backend: id, ok: false, detail: error?.message ?? String(error), code: error?.code };
  }
}
