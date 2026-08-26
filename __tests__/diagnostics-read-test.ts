import {
  applyDiagnosticsRead,
  EMPTY_DIAGNOSTICS,
  healthCheckRowCopy,
  healthChecksListCopy,
  healthChecksTitle,
  healthChecksVisibleOn,
  diagnosticsReadFromUnknown,
  type HealthCheck,
} from '@/lib/gateway/diagnostics-read';

const DB: HealthCheck = { name: 'db', status: 'ok' };
const TELEGRAM: HealthCheck = { name: 'telegram', status: 'connected' };
const GATEWAY: HealthCheck = { name: 'gateway', status: 'running' };

test('a Gate { status, checks } map becomes named checks, never a JSON dump', () => {
  const read = diagnosticsReadFromUnknown({ status: 'ok', checks: { db: 'ok' } });
  expect(read).toEqual({ ok: true, status: 'ok', checks: [DB] });
});

test('a checks array of { name, status } unwraps the same way', () => {
  const read = diagnosticsReadFromUnknown({
    status: 'ok',
    checks: [{ name: 'db', status: 'ok' }],
  });
  expect(read).toEqual({ ok: true, status: 'ok', checks: [DB] });
});

test('a check named only by id still parses', () => {
  const read = diagnosticsReadFromUnknown({
    status: 'ok',
    checks: [{ id: 'db', status: 'ok' }],
  });
  expect(read).toEqual({ ok: true, status: 'ok', checks: [DB] });
});

test('object check values take status, state, or ok', () => {
  const read = diagnosticsReadFromUnknown({
    status: 'ok',
    checks: {
      db: { status: 'ok', detail: 'primary' },
      cache: { state: 'ready' },
      disk: { ok: true },
      broken: { ok: false },
    },
  });
  expect(read).toEqual({
    ok: true,
    status: 'ok',
    checks: [
      { name: 'db', status: 'ok', detail: 'primary' },
      { name: 'cache', status: 'ready' },
      { name: 'disk', status: 'ok' },
      { name: 'broken', status: 'fail' },
    ],
  });
});

test('an empty checks map is empty-ok — the host reported none', () => {
  expect(diagnosticsReadFromUnknown({ status: 'ok', checks: {} })).toEqual({
    ok: true,
    status: 'ok',
    checks: [],
  });
  expect(diagnosticsReadFromUnknown({ status: 'ok', checks: [] })).toEqual({
    ok: true,
    status: 'ok',
    checks: [],
  });
});

test('nameless and non-object items are dropped, not a failed read', () => {
  const read = diagnosticsReadFromUnknown({
    status: 'ok',
    checks: [null, 42, { status: 'ok' }, { name: '  ' }, { name: 'db', status: 'ok' }],
  });
  expect(read).toEqual({ ok: true, status: 'ok', checks: [DB] });
});

test('a Hermes payload without checks still lists gateway_state and platforms', () => {
  const read = diagnosticsReadFromUnknown({
    status: 'ok',
    platform: 'hermes-agent',
    version: '0.16.0',
    gateway_state: 'running',
    platforms: { telegram: { state: 'connected' } },
    active_agents: 2,
    pid: 4242,
    updated_at: '2026-08-26T12:00:00Z',
  });
  expect(read).toEqual({ ok: true, status: 'ok', checks: [GATEWAY, TELEGRAM] });
});

test('an unparseable payload is a failed read, not "no health checks"', () => {
  expect(diagnosticsReadFromUnknown(null).ok).toBe(false);
  expect(diagnosticsReadFromUnknown('nope').ok).toBe(false);
  expect(diagnosticsReadFromUnknown({ error: 'boom' }).ok).toBe(false);
  expect(diagnosticsReadFromUnknown([]).ok).toBe(false);
});

test('a failed FIRST read claims zero knowledge — not an empty list', () => {
  const next = applyDiagnosticsRead(EMPTY_DIAGNOSTICS, { ok: false });
  expect(next.checks).toEqual([]);
  expect(next.loaded).toBe(false);
  expect(next.failed).toBe(true);
  expect(healthChecksTitle(next)).toBe('Health checks');
  expect(healthChecksTitle(next)).not.toContain('0');
  expect(healthChecksListCopy(next)).toBe('Health checks could not be read.');
});

test('a failed RE-read keeps the last good checks and names the staleness', () => {
  const loaded = applyDiagnosticsRead(EMPTY_DIAGNOSTICS, {
    ok: true,
    status: 'ok',
    checks: [DB, TELEGRAM],
  });
  const stale = applyDiagnosticsRead(loaded, { ok: false });
  expect(stale.checks).toEqual([DB, TELEGRAM]);
  expect(stale.status).toBe('ok');
  expect(stale.loaded).toBe(true);
  expect(stale.failed).toBe(true);
  expect(healthChecksTitle(stale)).toBe('Health checks (2)');
  expect(healthChecksListCopy(stale)).toBe(
    'Could not re-read health checks — showing the last list.',
  );
});

test('a successful EMPTY read is believed — this gateway really reported none', () => {
  const previous = applyDiagnosticsRead(EMPTY_DIAGNOSTICS, {
    ok: true,
    status: 'ok',
    checks: [DB],
  });
  const next = applyDiagnosticsRead(previous, { ok: true, status: 'ok', checks: [] });
  expect(next).toEqual({ status: 'ok', checks: [], loaded: true, failed: false });
  expect(healthChecksTitle(next)).toBe('Health checks (0)');
  expect(healthChecksListCopy(next)).toBe('No health checks.');
});

test('a successful refresh replaces the checks and clears the failure', () => {
  const previous = applyDiagnosticsRead(EMPTY_DIAGNOSTICS, {
    ok: true,
    status: 'ok',
    checks: [DB],
  });
  const stale = applyDiagnosticsRead(previous, { ok: false });
  const next = applyDiagnosticsRead(stale, { ok: true, status: 'degraded', checks: [TELEGRAM] });
  expect(next.checks).toEqual([TELEGRAM]);
  expect(next.status).toBe('degraded');
  expect(next.failed).toBe(false);
});

test('unread copy stays quiet until a read lands', () => {
  expect(healthChecksTitle(EMPTY_DIAGNOSTICS)).toBe('Health checks');
  expect(healthChecksListCopy(EMPTY_DIAGNOSTICS)).toBeUndefined();
});

test('the pane belongs on a Gate or Hermes host, not OpenClaw', () => {
  expect(healthChecksVisibleOn({ kind: 'custom' })).toBe(true);
  expect(healthChecksVisibleOn({ kind: 'hermes' })).toBe(true);
  expect(healthChecksVisibleOn({ kind: 'openclaw' })).toBe(false);
  expect(healthChecksVisibleOn({ kind: 'unknown' })).toBe(false);
  expect(healthChecksVisibleOn({})).toBe(false);
});

test('a row names the check and tones the status, never dumps JSON', () => {
  const ok = healthCheckRowCopy(DB);
  expect(ok.title).toBe('db');
  expect(ok.status).toBe('ok');
  expect(ok.tone).toBe('success');
  expect(ok.subtitle).toBeUndefined();

  expect(healthCheckRowCopy({ name: 'cache', status: 'degraded', detail: 'slow' })).toEqual({
    title: 'cache',
    subtitle: 'slow',
    status: 'degraded',
    tone: 'warning',
  });
  expect(healthCheckRowCopy({ name: 'disk', status: 'fail' }).tone).toBe('danger');
  expect(healthCheckRowCopy({ name: 'misc', status: 'unknown' }).tone).toBe('neutral');
});
