// ─── Per-gateway lastSeenAt ────────────────────────────────────────
// The "While you were away" digest (FUTURE-ITEMS §1b) needs to know when the
// operator was last looking at a gateway. Deliberately a pure key-value
// helper: the side-effecting wiring lives on Home, which stamps on unmount
// and app-background, and the digest reads it on arrival.
//
// Note the distinct concept: this is the OPERATOR's last visit, not a
// gateway's reachability sample — discovery's lastSeenAt is unrelated.

import { keyValueStorage } from '@/lib/storage/key-value';

export const LAST_SEEN_KEY_PREFIX = 'versutus:last-seen:';

function lastSeenKey(gatewayId: string): string {
  return `${LAST_SEEN_KEY_PREFIX}${gatewayId}`;
}

/**
 * Stamp one gateway's last-seen timestamp. An empty id (no gateway saved
 * yet) is a no-op — there is nothing to be "away from".
 */
export async function stampLastSeen(gatewayId: string, now = Date.now()): Promise<void> {
  const id = gatewayId.trim();
  if (!id) return;
  try {
    await keyValueStorage.setItem(lastSeenKey(id), String(now));
  } catch {
    // best-effort: a failed stamp only narrows the next digest, never lies.
  }
}

/**
 * Stamp every saved gateway for an app-level leave (background) — the
 * digest is per-gateway, so one visit was a visit to all of them.
 */
export async function stampAllLastSeen(gatewayIds: readonly string[], now = Date.now()): Promise<void> {
  await Promise.all(
    [...new Set(gatewayIds)].filter((id) => id.trim()).map((id) => stampLastSeen(id, now)),
  );
}

/**
 * Read back one gateway's last-seen timestamp, or null when nothing was
 * ever stamped. A corrupt stored value is unknown, not zero — "away since
 * the epoch" would make every run look overdue.
 */
export async function loadLastSeen(gatewayId: string): Promise<number | null> {
  try {
    const raw = await keyValueStorage.getItem(lastSeenKey(gatewayId));
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Clear one gateway's stamp — used when its gateway profile is deleted. */
export async function clearLastSeen(gatewayId: string): Promise<void> {
  try {
    await keyValueStorage.removeItem(lastSeenKey(gatewayId));
  } catch {
    // best-effort: a stale stamp only makes the first digest broader.
  }
}
