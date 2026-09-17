import { createHash } from 'node:crypto';

const PREFIX = 'gate-run-v1.';

/** A run carries its CLI environment across reconnects and Gate restarts. */
export function encodeBackendRunHandle(backendId, runId) {
  return PREFIX + Buffer.from(JSON.stringify([backendId, runId])).toString('base64url');
}

export function decodeBackendRunHandle(handle) {
  if (!handle.startsWith(PREFIX)) return null;
  try {
    const encoded = handle.slice(PREFIX.length);
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2 ||
        value.some((part) => typeof part !== 'string' || !part)) throw new Error();
    if (encodeBackendRunHandle(...value) !== handle) throw new Error();
    return { backendId: value[0], runId: value[1] };
  } catch {
    throw new Error('Invalid Gate run handle');
  }
}

/** Preserve the upstream response shape while exposing only scoped run ids. */
export function scopeBackendRunResponse(response, backendId) {
  const scoped = { ...response };
  for (const key of ['run_id', 'id']) {
    if (typeof scoped[key] === 'string' && scoped[key]) {
      scoped[key] = encodeBackendRunHandle(backendId, scoped[key]);
    }
  }
  return scoped;
}

/** Scoped handles can exceed the archive's filename limit; hash the whole scope. */
export function backendRunArchiveKey(handle) {
  return handle.startsWith(PREFIX)
    ? `scoped-${createHash('sha256').update(handle).digest('hex')}`
    : handle;
}
