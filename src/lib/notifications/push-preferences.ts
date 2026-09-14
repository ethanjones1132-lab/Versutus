// ─── Push notification preferences (Solution A6 / A8) ──────────────────────
// The pure folds behind the settings pane. The Gate's
// `notifications.preferences.get/set` is live (gate/core/push-rpc.mjs) and the
// notifier enforces every field (gate/core/push-notifier.mjs), so this module
// is only the app's reader and writer for the one seam the RPC answers — it
// folds nothing of its own about how a tray entry is built.
//
// Two honesty rules, the same shape the weekly-report and app-lock modules
// hold: a failed read answers a named failure rather than a fabricated
// preference list, and a patch carries exactly the fields the caller toggled —
// absent fields are never sent, so a pane holding one switch cannot reset the
// four the Gate stores (enabled / richBody / botIds / quietHours).
//
// Pure plus the seam: no expo import, no storage — the Gate is the authority
// (the row is keyed by the paired device's grant, not by anything this module
// supplies), so nothing is cached device-side that could outlive the answer.

/** The four fields the Gate's preferences row holds. */
export type PushPreferences = {
  /** The master toggle (A8 step 1): the relay stays dark while this is off. */
  enabled: boolean;
  /** A6's per-device opt-in: rich bodies replace the contentless default. */
  richBody: boolean;
  /** A4's per-Bot filter: the Bots this device hears from (empty = all). */
  botIds: string[];
  /** A4's quiet hours: { startMinutes, endMinutes }, or null when unset. */
  quietHours: { startMinutes: number; endMinutes: number } | null;
};

/** The Gate's own defaults (push-rpc.mjs DEFAULT_PREFERENCES) — never re-typed. */
export const PUSH_PREFERENCES_DEFAULTS: PushPreferences = Object.freeze({
  enabled: false,
  richBody: false,
  botIds: [],
  quietHours: null,
});

/** The `client.rpcRequest` seam, the same shape push-registration's Rpc holds. */
export type Rpc = {
  rpcRequest(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

/**
 * Whether this gateway advertises the preferences methods at all — the
 * capability gate the settings section renders behind. The manifest's
 * `rpcMethods` is the fact; an unknown (`undefined`) table says unknown, and
 * unknown advertises nothing.
 */
export function pushPreferencesAdvertised(rpcMethods: unknown): boolean {
  if (!Array.isArray(rpcMethods)) return false;
  return (
    rpcMethods.includes('notifications.preferences.get') &&
    rpcMethods.includes('notifications.preferences.set')
  );
}

/** True only for a boolean. A non-boolean collapses to its default, `false`. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The row's string array, or the default when it is anything else. */
function stringArrayOr(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** The row's quiet-hours record, or the default when it is anything else. */
function quietHoursOr(
  value: unknown,
  fallback: PushPreferences['quietHours'],
): PushPreferences['quietHours'] {
  if (
    value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { startMinutes?: unknown }).startMinutes === 'number'
    && typeof (value as { endMinutes?: unknown }).endMinutes === 'number'
  ) {
    return {
      startMinutes: (value as { startMinutes: number }).startMinutes,
      endMinutes: (value as { endMinutes: number }).endMinutes,
    };
  }
  return fallback;
}

/**
 * Fold one unknown Gate row into the preferences type, filling every absent
 * field from the documented defaults — a row holding only `enabled` still
 * names richBody, the filters and the window, so the pane never invents a
 * value the Gate did not (or does not yet) hold.
 */
export function pushPreferencesFromRow(row: unknown): PushPreferences {
  const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return {
    enabled: booleanOr(record.enabled, PUSH_PREFERENCES_DEFAULTS.enabled),
    richBody: booleanOr(record.richBody, PUSH_PREFERENCES_DEFAULTS.richBody),
    botIds: stringArrayOr(record.botIds, PUSH_PREFERENCES_DEFAULTS.botIds),
    quietHours: quietHoursOr(record.quietHours, PUSH_PREFERENCES_DEFAULTS.quietHours),
  };
}

export type PushPreferencesLoad =
  | { ok: true; preferences: PushPreferences }
  | { ok: false };

/** Read the paired-device row through the Gate's get method. */
export async function loadPushPreferences(rpc: Rpc): Promise<PushPreferencesLoad> {
  try {
    return { ok: true, preferences: pushPreferencesFromRow(await rpc.rpcRequest('notifications.preferences.get', {})) };
  } catch {
    // A read that cannot answer is a named failure at the call site; a
    // fabricated list here would paint switches for a state nobody read.
    return { ok: false };
  }
}

/**
 * The part of one patch that is actually set, in the Gate's own parameter
 * names. `undefined` fields are LEFT OUT of the params object entirely — the
 * Gate's diff-patch (`push-rpc.mjs`) keeps any field the params omit, so a
 * pane that toggles only `enabled` cannot reset quietHours or the allowlist.
 */
export function pushPreferencesPatch(
  updates: Partial<PushPreferences>,
): Record<string, unknown> {
  return {
    ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
    ...(updates.richBody !== undefined ? { richBody: updates.richBody } : {}),
    ...(updates.botIds !== undefined ? { botIds: updates.botIds } : {}),
    ...(updates.quietHours !== undefined ? { quietHours: updates.quietHours } : {}),
  };
}

export type PushPreferencesSetResult =
  | { ok: true; preferences: PushPreferences }
  | { ok: false };

/**
 * Write the patch, then read the state now in force — the Gate's answer is
 * the authority, and a refused patch answers the failure rather than the
 * optimistically-painted state, so the switch can always snap back honestly.
 */
export async function setPushPreferences(
  rpc: Rpc,
  updates: Partial<PushPreferences>,
): Promise<PushPreferencesSetResult> {
  try {
    await rpc.rpcRequest('notifications.preferences.set', pushPreferencesPatch(updates));
  } catch {
    return { ok: false };
  }
  return loadPushPreferences(rpc);
}
