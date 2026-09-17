import { createHash } from 'node:crypto';

const PREFIX = 'gate-run-v1.';
const BOT_PREFIX = 'gate-run-v2.';

/** A run carries its CLI environment and Bot across reconnects and Gate restarts. */
export function encodeBackendRunHandle(backendId, runId, botId) {
  const value = botId ? [backendId, runId, botId] : [backendId, runId];
  return (botId ? BOT_PREFIX : PREFIX) + Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeBackendRunHandle(handle) {
  const prefix = handle.startsWith(BOT_PREFIX) ? BOT_PREFIX : PREFIX;
  if (!handle.startsWith(prefix)) return null;
  try {
    const encoded = handle.slice(prefix.length);
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== (prefix === BOT_PREFIX ? 3 : 2) ||
        value.some((part) => typeof part !== 'string' || !part)) throw new Error();
    if (encodeBackendRunHandle(...value) !== handle) throw new Error();
    return { backendId: value[0], runId: value[1], ...(value[2] ? { botId: value[2] } : {}) };
  } catch {
    throw new Error('Invalid Gate run handle');
  }
}

/** Preserve the upstream response shape while exposing only scoped run ids. */
export function scopeBackendRunResponse(response, backendId, botId) {
  const scoped = { ...response };
  for (const key of ['run_id', 'id']) {
    if (typeof scoped[key] === 'string' && scoped[key]) {
      scoped[key] = encodeBackendRunHandle(backendId, scoped[key], botId);
    }
  }
  return scoped;
}

/** Scoped handles can exceed the archive's filename limit; hash the whole scope. */
export function backendRunArchiveKey(handle) {
  return handle.startsWith(PREFIX) || handle.startsWith(BOT_PREFIX)
    ? `scoped-${createHash('sha256').update(handle).digest('hex')}`
    : handle;
}
