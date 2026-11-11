import { toCronJobView } from './cron-view.mjs';

/**
 * Routines across every backend, for the Activity tab's Routines view.
 *
 * The read carries the same coverage contract Activity uses: a backend that
 * cannot list routines says so instead of returning an empty success, and one
 * host's refusal never hides another host's rows. Coverage is measured per
 * backend because that is the only unit whose read can fail.
 */

/** Bound one backend read so an unresponsive environment cannot hold the list. */
export function withRoutineTimeout(promise, timeoutMs = 8_000) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Backend routine read timed out')), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The reason a started backend gives when it has no routine concept after all.
 *
 * `/v1/routines` cannot know a backend's methods until it starts it (the
 * method probe answers `null` for a factory that needs a live transport), and
 * the started backend may turn out to have no `listJobs`. That is the same
 * fact as a backend that never advertised one — unavailable — so it travels as
 * this marker rather than as a read failure the app would paint red.
 */
export function unsupportedRoutineRead(label) {
  const error = new Error(`${label ? `${label}: ` : ''}routines are not supported by this backend`);
  error.code = 'routines_unsupported';
  return error;
}

function isUnsupportedRoutineRead(reason) {
  return reason?.code === 'routines_unsupported';
}

/**
 * The job rows in a host answer, or null when it is not a list at all.
 *
 * Same envelope keys `cron.jobs` reads: a host answering { crons: [...] } or
 * { items: [...] } must not look like an empty schedule. `null` is distinct
 * from `[]` — garbage is a failed read, an empty list is a real answer.
 */
export function routineRows(payload) {
  if (Array.isArray(payload)) return payload;
  const rows = payload?.data ?? payload?.jobs ?? payload?.crons ?? payload?.items;
  return Array.isArray(rows) ? rows : null;
}

/**
 * One routine row, or null for a job record that carries no id.
 *
 * `id` stays the host's own job id: /v1/jobs mutations address a job by it, and
 * `backendId` keeps two hosts' equal ids distinct. `name` is the display title
 * with the `[bot:<name>]` prefix removed, because ownership travels separately
 * in `botId`; a name without that prefix is shown untouched.
 */
export function routineRow(backend, job) {
  const view = toCronJobView(job);
  if (!view) return null;
  return {
    id: view.id,
    backendId: backend.id,
    ...(view.botId ? { botId: view.botId } : {}),
    name: view.title || view.id,
    ...(view.schedule ? { schedule: view.schedule } : {}),
    paused: view.paused,
    ...(view.lastRunAt ? { lastRunAt: view.lastRunAt } : {}),
    ...(view.lastStatus ? { lastStatus: view.lastStatus } : {}),
    ...(view.nextRunAt ? { nextRunAt: view.nextRunAt } : {}),
  };
}

function skippedRowsMessage(skipped) {
  return skipped === 1 ? '1 routine row could not be read' : `${skipped} routine rows could not be read`;
}

/** Aggregate routine listings without inventing backend facts. */
export async function collectRoutines({ backendId, backends = [], now = Date.now(), timeoutMs = 8_000 } = {}) {
  const coverage = [];
  const routines = [];

  const selected = backends.filter((entry) => !backendId || entry.id === backendId);
  // Backends are read in parallel so one slow host's timeout does not add to
  // the others' wait. Each read carries its own bound: a host that never
  // answers is a failed read within the timeout, while its neighbours still
  // report theirs.
  const reads = await Promise.all(selected.map(async (backend) => {
    // A backend that offers no routine listing is unavailable, never "no
    // routines": the app must explain unsupported, not show a false zero.
    if (typeof backend.listJobs !== 'function') return { backend, unsupported: true };
    try {
      const value = await withRoutineTimeout(
        Promise.resolve().then(() => backend.listJobs()),
        timeoutMs,
      );
      return { backend, result: { status: 'fulfilled', value } };
    } catch (reason) {
      // A backend that only discovered it has no `listJobs` after starting is
      // the same fact as one that never had it: unavailable, not a failure.
      if (isUnsupportedRoutineRead(reason)) return { backend, unsupported: true };
      return { backend, result: { status: 'rejected', reason } };
    }
  }));

  for (const { backend, unsupported, result } of reads) {
    if (unsupported) {
      coverage.push({ id: backend.id, label: backend.label, status: 'unavailable' });
      continue;
    }
    if (result.status === 'rejected') {
      coverage.push({
        id: backend.id,
        label: backend.label,
        status: 'failed',
        error: String(result.reason?.message ?? result.reason).slice(0, 160),
      });
      continue;
    }
    const rows = routineRows(result.value);
    if (!rows) {
      coverage.push({
        id: backend.id,
        label: backend.label,
        status: 'failed',
        error: 'Backend returned no routine list',
      });
      continue;
    }
    const parsed = rows.map((job) => routineRow(backend, job));
    const readable = parsed.filter(Boolean);
    const skipped = rows.length - readable.length;
    // failed: nothing that exists could be read. partial: some of it could.
    coverage.push({
      id: backend.id,
      label: backend.label,
      status: skipped === 0 ? 'complete' : readable.length === 0 ? 'failed' : 'partial',
      ...(skipped ? { error: skippedRowsMessage(skipped) } : {}),
    });
    routines.push(...readable);
  }

  // Host order is kept, and backends contribute in the order the Gate lists
  // them: the app groups by Bot, so the Gate does not invent a sort.
  return {
    generatedAt: new Date(now).toISOString(),
    backends: coverage,
    routines,
  };
}
