// ─── Per-Bot spend caps (D5 budgets with hard stops) — the store ───────────
// The cap state is phone-side key-value storage (the last-seen pattern);
// the verdict fold and copy live in the pure sibling `spend-cap-verdict.ts`,
// which is what code that cannot load native storage imports. Enforcement
// is client-side, so it governs runs started from THIS app — every surface
// that names a cap says so, and never implies a server quota.

import { keyValueStorage } from '@/lib/storage/key-value';

export {
  SPEND_CAP_LIMIT_COPY,
  spendCapNoticeCopy,
  spendCapRefusalCopy,
  spendCapVerdict,
  type SpendCapVerdict,
} from '@/lib/settings/spend-cap-verdict';

/** One store for every gateway, one key per Bot — the last-seen pattern. */
const CAP_KEY_PREFIX = 'versutus:spend-cap:';

function capKey(botId: string): string {
  return `${CAP_KEY_PREFIX}${botId}`;
}

/**
 * Set (or clear, with null) one Bot's cap. A blank id stores nothing —
 * there is no Bot the cap could govern. A negative or non-finite number is
 * not a cap, and is never stored behind the Bot's key: garbage must not
 * become a policy nobody wrote. Fire-and-forget friendly — the verdict
 * fold never depends on this write having landed.
 */
export async function setBotSpendCap(botId: string, capUsd: number | null): Promise<void> {
  const id = botId.trim();
  if (!id) return;
  try {
    if (capUsd == null) {
      await keyValueStorage.removeItem(capKey(id));
    } else if (Number.isFinite(capUsd) && capUsd >= 0) {
      await keyValueStorage.setItem(capKey(id), String(capUsd));
    }
  } catch {
    // best-effort: a failed write only leaves the old cap standing.
  }
}

/**
 * Read one Bot's cap, or null when none is set. A corrupt stored value is
 * unknown, not zero — a zero cap would pause everything and read as a
 * policy nobody wrote.
 */
export async function loadBotSpendCap(botId: string): Promise<number | null> {
  try {
    const raw = await keyValueStorage.getItem(capKey(botId.trim()));
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}
