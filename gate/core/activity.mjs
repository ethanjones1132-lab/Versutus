export const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIVITY_ITEM_LIMIT = 500;
export const ACTIVITY_READ_TIMEOUT_MS = 8_000;
/**
 * A cold agent server's first start is not a read: `opencode serve` after a
 * reboot is documented as taking well over 30 s, longer than the supervisor's
 * own start bound. Giving the start its own ceiling keeps that wait out of the
 * 8 s read bound while still capping a genuinely hung environment.
 */
export const ACTIVITY_START_TIMEOUT_MS = 35_000;

/** Parse the required ISO instant without accepting dates that Date.parse repairs. */
export function parseActivitySince(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'since is required and must be a valid ISO instant' };
  }
  const parts = value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(?:Z|[+-](\d\d):(\d\d))$/);
  const [, year, month, day, hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] = parts ?? [];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const validDate = parts
    && date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59;
  const timestamp = Date.parse(value);
  if (!validDate || !Number.isFinite(timestamp)) {
    return { error: 'since must be a valid ISO instant, such as 2026-11-10T00:00:00.000Z' };
  }
  return { since: new Date(timestamp).toISOString(), timestamp };
}

/** Bound one backend step so an unresponsive environment cannot hold the feed. */
export function withActivityTimeout(promise, timeoutMs = ACTIVITY_READ_TIMEOUT_MS, message = 'Backend activity read timed out') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The `/v1/activity` session read, start included. `get` starts the
 * environment's native server, so bounding it with the read used to report a
 * cold server as a failed backend before its first start could finish. The
 * start gets its own longer bound; only the list keeps the 8 s read ceiling.
 */
export async function readActivitySessions({
  start,
  limit = 500,
  startTimeoutMs = ACTIVITY_START_TIMEOUT_MS,
  readTimeoutMs = ACTIVITY_READ_TIMEOUT_MS,
}) {
  const backend = await withActivityTimeout(
    Promise.resolve().then(start),
    startTimeoutMs,
    'Backend activity start timed out',
  );
  if (typeof backend?.listSessions !== 'function') throw new Error('Sessions are unavailable');
  return withActivityTimeout(Promise.resolve().then(() => backend.listSessions(limit)), readTimeoutMs);
}

/** The first non-empty title wins; an empty string must not drop the row later. */
function activityTitle(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return 'Session';
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

function optionalMetric(metrics, key, value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) metrics[key] = value;
}

function sessionItem(backend, session) {
  const started = timestamp(session?.started_at);
  const active = timestamp(session?.last_active ?? session?.updated_at ?? session?.started_at);
  if (!Number.isFinite(active)) return null;
  const metrics = {};
  optionalMetric(metrics, 'turns', session.message_count);
  optionalMetric(metrics, 'tools', session.tool_call_count);
  const tokenValues = [
    session.input_tokens,
    session.output_tokens,
    session.cache_read_tokens,
    session.cache_write_tokens,
    session.reasoning_tokens,
  ].filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (tokenValues.length) metrics.tokens = tokenValues.reduce((sum, value) => sum + value, 0);
  optionalMetric(metrics, 'costUsd', session.actual_cost_usd ?? session.estimated_cost_usd);
  const ended = timestamp(session.ended_at);
  return {
    id: `${backend.id}:session:${session.id}`,
    backendId: backend.id,
    kind: 'session',
    sessionId: String(session.id),
    startedAt: Number.isFinite(started) ? new Date(started).toISOString() : new Date(active).toISOString(),
    status: session.ended_at == null ? 'active' : (session.end_reason ?? 'completed'),
    title: activityTitle(session.title, session.preview),
    metrics,
    _activityAt: active,
    ...(typeof session.bot === 'string' && session.bot ? { botId: session.bot } : {}),
    ...(Number.isFinite(ended) ? { finishedAt: new Date(ended).toISOString() } : {}),
  };
}

function runItem(backend, run) {
  const started = timestamp(run?.startedAt);
  if (!Number.isFinite(started)) return null;
  const ended = timestamp(run.endedAt);
  return {
    id: `${backend.id}:run:${run.runId}`,
    backendId: backend.id,
    kind: 'run',
    startedAt: new Date(started).toISOString(),
    status: run.state ?? 'unknown',
    title: run.operation ?? 'Run',
    metrics: {},
    // A run that began before `since` but finished after it belongs to the window.
    _activityAt: Number.isFinite(ended) ? Math.max(started, ended) : started,
    ...(Number.isFinite(ended) ? { finishedAt: new Date(ended).toISOString() } : {}),
  };
}

/** Aggregate archived runs and sessions without inventing backend facts. */
export async function collectActivity({
  since,
  backendId,
  backends,
  now = Date.now(),
  windowMs = ACTIVITY_WINDOW_MS,
  itemLimit = ACTIVITY_ITEM_LIMIT,
}) {
  const parsed = parseActivitySince(since);
  if (parsed.error) throw new TypeError(parsed.error);
  const effectiveSince = Math.max(parsed.timestamp, now - windowMs);
  const coverage = [];
  const items = [];

  const selected = backends.filter((entry) => !backendId || entry.id === backendId);
  // Backends are read in parallel so one slow backend's timeout does not add to the others'.
  const reads = await Promise.all(selected.map(async (backend) => {
    const hasRuns = typeof backend.listRuns === 'function';
    const hasSessions = typeof backend.listSessions === 'function';
    const [runsResult, sessionsResult] = await Promise.allSettled([
      hasRuns ? Promise.resolve().then(() => backend.listRuns()) : Promise.reject(new Error('Run history unavailable')),
      hasSessions ? Promise.resolve().then(() => backend.listSessions()) : Promise.reject(new Error('Sessions unavailable')),
    ]);
    return { backend, hasRuns, hasSessions, runsResult, sessionsResult };
  }));

  for (const { backend, hasRuns, hasSessions, runsResult, sessionsResult } of reads) {
    const available = [hasRuns, hasSessions].filter(Boolean).length;
    const failed = [[runsResult, hasRuns], [sessionsResult, hasSessions]]
      .filter(([result, isAvailable]) => isAvailable && result.status === 'rejected')
      .map(([result]) => result);
    // failed: nothing that exists could be read. partial: some of it could, or the
    // backend offers only one of the two reads. unavailable: it offers neither.
    const status = available === 0 ? 'unavailable'
      : failed.length === available ? 'failed'
        : failed.length > 0 || available < 2 ? 'partial' : 'complete';
    coverage.push({
      id: backend.id,
      label: backend.label,
      status,
      ...(failed.length ? { error: String(failed[0].reason?.message ?? failed[0].reason).slice(0, 160) } : {}),
    });
    if (runsResult.status === 'fulfilled') {
      for (const run of Array.isArray(runsResult.value) ? runsResult.value : []) {
        const item = runItem(backend, run);
        if (item && item._activityAt >= effectiveSince) items.push(item);
      }
    }
    if (sessionsResult.status === 'fulfilled') {
      const rows = Array.isArray(sessionsResult.value) ? sessionsResult.value : [];
      for (const session of rows) {
        const item = sessionItem(backend, session);
        if (item && item._activityAt >= effectiveSince) items.push(item);
      }
    }
  }

  items.sort((a, b) => b._activityAt - a._activityAt || a.id.localeCompare(b.id));
  const truncated = {};
  if (parsed.timestamp < effectiveSince) truncated.window = true;
  if (items.length > itemLimit) truncated.items = true;
  return {
    since: parsed.since,
    generatedAt: new Date(now).toISOString(),
    backends: coverage,
    items: items.slice(0, itemLimit).map(({ _activityAt, ...item }) => item),
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}
