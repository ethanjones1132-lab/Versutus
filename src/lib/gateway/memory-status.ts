// ─── Memory doctor status, read on demand ────────────────────────────
// The `/memory` registry entry (dashboard.ts) asks `doctor.memory.status`
// under `operator.read`, capability-gated on the Memory group's
// `memory_write_api` feature flag. Until now the only render of that reply
// was the `/memory` slash line. This module is the read-first surface's
// fold: the SAME reply, answered as one honest line a Bot's detail sheet
// can place beside the soul block. Edits stay behind this slice.
//
// Pure: no fetch, no storage — the sheet's parent owns the read, exactly
// like the soul read does (bots.ts BotSoulRead / applyBotSoulRead), so a
// Gateway that does not serve the method renders as a failed read, never
// as healthy-sounding silence.

export type MemoryStatusState = {
  /** True once a read has answered with a status — a failed read has learned nothing. */
  loaded: boolean;
  /** True when the read failed or answered with nothing readable. */
  failed: boolean;
  /**
   * The status word AS THE HOST SAID IT (the case preserved) — a state is
   * a fact about the memory, re-wording it would be a second record.
   */
  status?: string;
  /** The host's stated reason, when it gave one. */
  detail?: string;
};

const STATUS_KEYS = ['status', 'state', 'ok', 'healthy'];

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/**
 * Read one `doctor.memory.status` reply. A reply with NO status the fold
 * can read is a fact about the read, not the memory — FAILED, never
 * invented into a state. `ok: false` is the host's own verdict and stays
 * verbatim-shaped ("not ok"), not softened.
 */
export function memoryStatusFromUnknown(raw: unknown): MemoryStatusState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { loaded: false, failed: true, status: undefined, detail: undefined };
  }
  const record = raw as Record<string, unknown>;
  const reason = firstString(record, ['reason', 'detail', 'message']);
  const booleanVerdict = firstBoolean(record, STATUS_KEYS);
  let status = firstString(record, STATUS_KEYS);
  if (!status && booleanVerdict !== undefined) {
    status = booleanVerdict ? 'ok' : 'not ok';
  }
  if (!status) {
    // No status anywhere in the reply: the read answered but said nothing
    // about health. Same empty-vs-failed line the soul read holds.
    return { loaded: false, failed: true, status: undefined, detail: undefined };
  }
  return { loaded: true, failed: false, status, ...(reason ? { detail: reason } : {}) };
}

/**
 * The one line the surface renders beside the soul block. A failed read
 * says so; a succeeded read says what the host said, with its reason,
 * never a re-worded verdict.
 */
export function memoryStatusCopy(state: MemoryStatusState): string {
  if (!state.loaded && state.failed) return 'Memory status could not be read.';
  return state.detail
    ? `Memory doctor: ${state.status} — ${state.detail}`
    : `Memory doctor: ${state.status}`;
}
