/**
 * Last-known-good data, kept on the device.
 *
 * Until now the only thing this app cached locally was a Gate's manifest. Every
 * other read — the Bot roster, the session list, the model catalog, a thread's
 * chat history — went to the network on each visit, so a slow or refused read
 * was always visible: the screen was empty, or loading, or an error, even
 * though this device had answered the same question minutes ago. This store is
 * the stale-while-revalidate half of that: a paint from disk first, the network
 * second, and only a successful network read may replace what is on screen.
 *
 * Rules that keep it honest:
 *   - Nothing secret is ever written. Only DTOs the UI already renders, with
 *     every credential-shaped field stripped first (`stripSecretFields`) — the
 *     store sits on unencrypted AsyncStorage, so a Gate token that leaked in
 *     here would outlive the profile.
 *   - Nothing throws. A cache is an optimisation: a missing key, corrupt JSON,
 *     a full disk or a locked-down browser all read as "no cached copy".
 *   - Nothing unbounded. A value over `SWR_MAX_BYTES` is dropped rather than
 *     written, and 20 entries are held in memory in front of the disk.
 */

import { keyValueStorage } from '@/lib/storage/key-value';

const PREFIX = 'versutus:swr:';

/** A cached value larger than this is not written at all. */
export const SWR_MAX_BYTES = 150 * 1024;

/** How many entries the in-memory front holds before the oldest is dropped. */
export const SWR_MEMORY_ENTRIES = 20;

/**
 * The namespaces this store writes. `clearCachedForGateway` needs them because
 * a cache key is `versutus:swr:<namespace>:<gatewayId>:<key>` and some callers
 * widen `<gatewayId>` with a scope (`<gateway>:<bot|cfg>:<backend>`) — a
 * gateway is then identified by the PREFIX of that field, not by one segment.
 */
export const SWR_NAMESPACES = ['roster', 'sessions', 'models', 'history'] as const;

export type SwrNamespace = (typeof SWR_NAMESPACES)[number] | (string & {});

/** What a cached read hands back, and when the bytes were written. */
export type CachedValue<T> = { value: T; savedAt: number };

type StoredEnvelope = { v: 1; savedAt: number; value: unknown };

/** Insertion order is the LRU order: the first key is the least recent. */
const memory = new Map<string, StoredEnvelope>();

/** One write chain per storage key, so two reads racing one key cannot interleave. */
const writeChains = new Map<string, Promise<void>>();

export function swrCacheKey(namespace: string, gatewayId: string, key: string): string {
  return `${PREFIX}${namespace}:${gatewayId}:${key}`;
}

/**
 * Field names that must never reach the store. Matched per WORD, so
 * `listenKey`, `api_key` and `authToken` are caught while `monkey` is not.
 */
const SECRET_WORDS = new Set([
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passphrase',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'bearer',
  'apikey',
  'key',
  'keys',
  'signature',
]);

export function isSecretFieldName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words.some((word) => SECRET_WORDS.has(word));
}

/**
 * A deep copy of `value` with every credential-shaped field dropped. Unknown
 * shapes pass through untouched apart from the sweep: this is a backstop for
 * whatever a future Gate adds to a DTO, not a validator.
 */
export function stripSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSecretFields(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretFieldName(name)) continue;
    out[name] = stripSecretFields(item);
  }
  return out;
}

function remember(key: string, envelope: StoredEnvelope): void {
  memory.delete(key);
  memory.set(key, envelope);
  while (memory.size > SWR_MEMORY_ENTRIES) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
}

function forget(key: string): void {
  memory.delete(key);
}

/** The last good copy this device holds, or null for anything unreadable. */
export async function readCached<T>(
  namespace: string,
  gatewayId: string,
  key: string,
): Promise<CachedValue<T> | null> {
  const storageKey = swrCacheKey(namespace, gatewayId, key);
  const held = memory.get(storageKey);
  if (held) {
    remember(storageKey, held);
    return { value: held.value as T, savedAt: held.savedAt };
  }
  let raw: string | null = null;
  try {
    raw = await keyValueStorage.getItem(storageKey);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written or corrupted blob is a miss, never a crash.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const envelope = parsed as Partial<StoredEnvelope>;
  if (envelope.v !== 1) return null;
  if (typeof envelope.savedAt !== 'number' || !Number.isFinite(envelope.savedAt)) return null;
  if (!('value' in envelope)) return null;
  remember(storageKey, envelope as StoredEnvelope);
  return { value: envelope.value as T, savedAt: envelope.savedAt };
}

/**
 * Keep `value` as the last good copy. An oversized value is refused outright.
 * The previous copy is kept: deleting it would make an oversized catalogue
 * permanently unpaintable, and a byte-size cap is not a reason to throw away
 * the copy already on the disk.
 */
export async function writeCached<T>(
  namespace: string,
  gatewayId: string,
  key: string,
  value: T,
): Promise<void> {
  const storageKey = swrCacheKey(namespace, gatewayId, key);
  const envelope: StoredEnvelope = { v: 1, savedAt: Date.now(), value: stripSecretFields(value) as unknown };
  let raw: string;
  try {
    raw = JSON.stringify(envelope);
  } catch {
    return;
  }
  if (typeof raw !== 'string' || raw.length > SWR_MAX_BYTES) {
    // Too big to write. The copy already held — if any — stays where it is.
    return;
  }
  remember(storageKey, envelope);
  const previous = writeChains.get(storageKey) ?? Promise.resolve();
  // Chain per key: the newest write must land last, whatever order two reads
  // finished their network call in.
  const chained = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await keyValueStorage.setItem(storageKey, raw);
      } catch {
        // Never throw into the read path that produced this value.
      }
    })
    .finally(() => {
      if (writeChains.get(storageKey) === chained) writeChains.delete(storageKey);
    });
  writeChains.set(storageKey, chained);
  await chained;
}

/** Forget every cached copy belonging to one gateway (and its scoped views). */
export async function clearCachedForGateway(gatewayId: string): Promise<void> {
  const prefixes = SWR_NAMESPACES.map((namespace) => `${PREFIX}${namespace}:${gatewayId}:`);
  for (const storageKey of [...memory.keys()]) {
    if (prefixes.some((prefix) => storageKey.startsWith(prefix))) forget(storageKey);
  }
  let keys: string[];
  try {
    keys = await keyValueStorage.getAllKeys();
  } catch {
    return;
  }
  const doomed = keys.filter((storageKey) => prefixes.some((prefix) => storageKey.startsWith(prefix)));
  if (doomed.length === 0) return;
  try {
    await keyValueStorage.multiRemove(doomed);
  } catch {
    // Nothing here is worth failing a delete over.
  }
}