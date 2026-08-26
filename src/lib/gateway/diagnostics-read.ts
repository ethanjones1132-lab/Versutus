/** One named check from GET /health/detailed. */
export type HealthCheck = {
  name: string;
  status: string;
  detail?: string;
};

/** What one diagnostics.full / status read produced. */
export type DiagnosticsRead =
  | { ok: true; status: string; checks: HealthCheck[] }
  | { ok: false };

/**
 * Visible health checks after folding a read. Two failures are not the
 * same fact:
 *   - A failed FIRST read claims zero knowledge — not "no health checks".
 *   - A failed RE-read keeps the last good list and marks it stale.
 * Only a successful read may clear or replace the list.
 */
export type DiagnosticsState = {
  status: string;
  checks: HealthCheck[];
  /** True once a successful read has landed. */
  loaded: boolean;
  failed: boolean;
};

export const EMPTY_DIAGNOSTICS: DiagnosticsState = {
  status: '',
  checks: [],
  loaded: false,
  failed: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function statusFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'ok' : 'fail';
  return undefined;
}

function parseCheckValue(name: string, raw: unknown): HealthCheck | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    const status = statusFromUnknown(raw);
    if (!status) return null;
    return { name: trimmed, status };
  }
  if (!isRecord(raw)) return null;
  const status =
    statusFromUnknown(raw.status) ?? statusFromUnknown(raw.state) ?? statusFromUnknown(raw.ok);
  if (!status) return null;
  const detail = (stringField(raw, 'detail') ?? stringField(raw, 'message') ?? '').trim();
  return detail ? { name: trimmed, status, detail } : { name: trimmed, status };
}

function parseCheckItem(raw: unknown): HealthCheck | null {
  if (!isRecord(raw)) return null;
  const name = stringField(raw, 'name') ?? stringField(raw, 'id') ?? '';
  return parseCheckValue(name, raw);
}

function checksFromMap(raw: Record<string, unknown>): HealthCheck[] {
  const checks: HealthCheck[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const check = parseCheckValue(name, value);
    if (check) checks.push(check);
  }
  return checks;
}

function checksFromArray(raw: unknown[]): HealthCheck[] {
  const checks: HealthCheck[] = [];
  for (const item of raw) {
    const check = parseCheckItem(item);
    if (check) checks.push(check);
  }
  return checks;
}

/**
 * Hermes /health/detailed has no `checks` key. The named facts are
 * gateway_state and each platform's state. pid / version / active_agents
 * are not checks.
 */
function checksFromHermes(raw: Record<string, unknown>): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const gateway = parseCheckValue('gateway', raw.gateway_state);
  if (gateway) checks.push(gateway);
  if (isRecord(raw.platforms)) {
    for (const [name, value] of Object.entries(raw.platforms)) {
      const check = parseCheckValue(name, value);
      if (check) checks.push(check);
    }
  }
  return checks;
}

/**
 * Parse a diagnostics.full / GET /health/detailed payload. The Gate stub
 * is `{ status, checks: { db: 'ok' } }`. Hermes returns gateway_state and
 * platforms instead of a checks map. Anything else is a failed read —
 * never an empty-ok list — so a junk envelope cannot render as
 * "no health checks".
 */
export function diagnosticsReadFromUnknown(raw: unknown): DiagnosticsRead {
  if (!isRecord(raw)) return { ok: false };
  const status = (stringField(raw, 'status') ?? '').trim();
  if (Array.isArray(raw.checks)) {
    if (!status) return { ok: false };
    return { ok: true, status, checks: checksFromArray(raw.checks) };
  }
  if (isRecord(raw.checks)) {
    if (!status) return { ok: false };
    return { ok: true, status, checks: checksFromMap(raw.checks) };
  }
  if (raw.checks !== undefined) return { ok: false };
  const hermes = checksFromHermes(raw);
  if (!status && hermes.length === 0) return { ok: false };
  return { ok: true, status, checks: hermes };
}

export function applyDiagnosticsRead(
  previous: DiagnosticsState,
  read: DiagnosticsRead,
): DiagnosticsState {
  if (read.ok) {
    return { status: read.status, checks: read.checks, loaded: true, failed: false };
  }
  if (previous.loaded) {
    return { status: previous.status, checks: previous.checks, loaded: true, failed: true };
  }
  return { status: '', checks: [], loaded: false, failed: true };
}

export function healthChecksTitle(state: DiagnosticsState): string {
  if (!state.loaded) return 'Health checks';
  return `Health checks (${state.checks.length})`;
}

export function healthChecksListCopy(state: DiagnosticsState): string | undefined {
  if (!state.loaded && state.failed) return 'Health checks could not be read.';
  if (state.failed) return 'Could not re-read health checks — showing the last list.';
  if (state.loaded && state.checks.length === 0) return 'No health checks.';
  return undefined;
}

/**
 * GET /health/detailed is on Hermes and on the Gate (kind `custom`).
 * OpenClaw has only the shallow /health probe — showing "could not be
 * read" there would be a lie about a surface it never had.
 */
export function healthChecksVisibleOn(input: { kind?: string }): boolean {
  return input.kind === 'custom' || input.kind === 'hermes';
}

const SUCCESS = new Set(['ok', 'healthy', 'running', 'connected', 'ready', 'up', 'pass', 'passed']);
const WARN = new Set(['warn', 'warning', 'degraded']);
const DANGER = new Set([
  'error',
  'fail',
  'failed',
  'down',
  'unhealthy',
  'disconnected',
  'critical',
]);

export type HealthCheckTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function healthCheckTone(status: string): HealthCheckTone {
  const key = status.trim().toLowerCase();
  if (SUCCESS.has(key)) return 'success';
  if (WARN.has(key)) return 'warning';
  if (DANGER.has(key)) return 'danger';
  return 'neutral';
}

/** Title, optional detail, and badge for one named check. Never JSON. */
export function healthCheckRowCopy(check: HealthCheck): {
  title: string;
  subtitle?: string;
  status: string;
  tone: HealthCheckTone;
} {
  return {
    title: check.name,
    subtitle: check.detail,
    status: check.status,
    tone: healthCheckTone(check.status),
  };
}
