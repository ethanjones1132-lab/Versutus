// ─── Memory doctor status, one honest line ───────────────────────────
// The Memory dice entry (dashboard.ts) asks `doctor.memory.status` and the
// chat reply rendered the raw payload. This fold answers the same read as
// ONE line, shown where gateway health already shows
// (HealthChecksPane, next to the named health checks).
//
// The status is HOST-wide: memory lives on the gateway host and the API
// server only scopes it via a header (rpc-routes METHOD_GUIDANCE), so the
// copy must never claim it describes one Bot.
//
// Pure: no fetch, no storage — the pane owns the read the same way it owns
// the diagnostics.full read. A body the fold cannot read is UNKNOWN,
// never the healthy default a `??`-chain would hand out.

export type MemoryStatusState = {
  /** True once a read has answered with a status — a failed read has learned nothing. */
  loaded: boolean;
  /** True when the read failed or answered with nothing readable. */
  failed: boolean;
  /**
   * The status word AS THE HOST SAID IT (case preserved) — a state is a
   * fact about the memory; re-wording it would be a second record.
   */
  status?: string;
  /** The host's stated reason, when it gave one. */
  detail?: string;
};

const STATUS_KEYS = ['status', 'state'];

const OK_WORDS = new Set(['ok', 'healthy', 'ready', 'up', 'connected']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
 * Read one `doctor.memory.status` reply. A reply with NO status the fold can
 * read is a fact about the read, not the memory — failed (unknown), never
 * invented into a state. `ok: false` is the host's own verdict and stays
 * verbatim-shaped ("not ok"), not softened.
 */
export function memoryStatusFromUnknown(raw: unknown): MemoryStatusState {
  if (!isRecord(raw)) {
    return { loaded: false, failed: true, status: undefined, detail: undefined };
  }
  const reason = firstString(raw, ['reason', 'detail', 'message']);
  const booleanVerdict = firstBoolean(raw, ['ok', 'healthy']);
  let status = firstString(raw, STATUS_KEYS);
  if (!status && booleanVerdict !== undefined) {
    status = booleanVerdict ? 'ok' : 'not ok';
  }
  if (!status) {
    // No status anywhere in the reply: the read answered but said nothing
    // about health. Same empty-vs-failed line the diagnostics read holds —
    // a blob of store entries is unknown, never "healthy".
    return { loaded: false, failed: true, status: undefined, detail: undefined };
  }
  return { loaded: true, failed: false, status, ...(reason ? { detail: reason } : {}) };
}

/** Tone for the pane's badge, on the same vocabulary as healthCheckTone. */
export function memoryStatusTone(state: MemoryStatusState): 'neutral' | 'success' | 'warning' | 'danger' {
  if (!state.loaded) return 'neutral';
  const key = state.status?.trim().toLowerCase();
  if (key && OK_WORDS.has(key)) return 'success';
  if (key === 'degraded' || key === 'warn' || key === 'warning') return 'warning';
  return 'danger';
}

/**
 * The one line the surface renders beside the health checks. A failed read
 * says so; a succeeded read says what the host said, with its reason,
 * never a re-worded verdict — and never names a Bot, because this status
 * describes the gateway host's memory, not any single Bot.
 */
export function memoryStatusCopy(state: MemoryStatusState): string {
  if (!state.loaded && state.failed) return 'Memory status could not be read.';
  const base = state.detail
    ? `Memory doctor: ${state.status} (host-wide) — ${state.detail}`
    : `Memory doctor: ${state.status} (host-wide)`;
  return base;
}
