// ─── Scheduled routine notices: one notices per routine, persisted ──
// Routines are scheduled on the gateway as 5-field cron; this module posts
// the phone-side LOCAL notice at that time. Honesty rule (FUTURE-ITEMS §1a):
// the notice fires at the scheduled time whether or not the gateway actually
// ran — copy says "due", never a result count.
//
// Deliberately a sibling of local.ts (immediate notices) so the immediate
// paths keep their own lives: approval / run-complete / gateway-down notices
// stay on `trigger: null` and touch nothing here. The ONE thing this module
// shares with local.ts is the permission gate, and it shares it rather than
// keeping a second copy of the older asking gate — see
// `ensureNotificationPermission`.

import * as Notifications from 'expo-notifications';
import type { NotificationRequest } from 'expo-notifications';

import { ensureNotificationPermission } from './local';
import {
  ROUTINE_NOTICE_DATA_KIND,
  cronToTrigger,
  routineNoticeData,
  routineNoticeTitle,
} from './routine-schedule';
import type { RoutineJob } from '@/lib/gateway/routines';
import { parseRoutineName } from '@/lib/gateway/routines';
import { keyValueStorage } from '@/lib/storage/key-value';

/**
 * Storage key for one routine job's scheduled-notification identifier, so
 * an edit re-schedules exactly ONE notice — never a firing copy per sync.
 * On-disk (key-value, not an in-memory map like
 * `gatewayDownNotificationIds` in local.ts) because a routine's notice must
 * outlive the process holding it.
 */
function noticeKey(jobId: string): string {
  return `versutus:routine-notification:${jobId}`;
}

/**
 * The tail of the sync chain for each routine, keyed by job id.
 *
 * Two re-arm callers exist — the connect-time re-arm and a Bot Chat's own
 * routine read — and they overlap. Unsynchronised, both scheduled a new notice
 * for the same job, both retired the OLD id and both wrote a new one, so the
 * loser of the write was orphaned in the OS queue: a second "Routine X is due"
 * firing beside the live one, retired by nothing. A chain makes the second
 * caller wait for the first, and the reconcile at the end of a re-arm sweeps
 * whatever earlier collisions left behind.
 */
const syncTails = new Map<string, Promise<void>>();

/**
 * Run one routine's work behind whatever that job is already syncing.
 *
 * A rejected run must not poison the chain for the next one: the tail settles
 * either way, so a scheduler that throws leaves the following re-arm free to
 * try again.
 */
function serialiseSync(jobId: string, work: () => Promise<void>): Promise<void> {
  const queued = syncTails.get(jobId) ?? Promise.resolve();
  const run = queued.then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  syncTails.set(jobId, tail);
  void tail.then(() => {
    if (syncTails.get(jobId) === tail) syncTails.delete(jobId);
  });
  return run;
}

/** The identifier this job is currently scheduled under, or null. */
async function readKnownNotice(jobId: string): Promise<string | null> {
  try {
    return await keyValueStorage.getItem(noticeKey(jobId));
  } catch {
    return null;
  }
}

/**
 * Cancel one already-named schedule. Best-effort: a schedule the phone has
 * already dropped is nothing left to fix.
 */
async function cancelNotice(identifier: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  } catch {
    // best-effort
  }
}

/**
 * Cancel one routine's known scheduled notice and clear its persisted id,
 * best-effort: a vanished schedule or a locked store must never block the
 * sync that follows.
 */
async function cancelKnownNotice(jobId: string): Promise<void> {
  const knownId = await readKnownNotice(jobId);
  if (knownId) await cancelNotice(knownId);
  try {
    await keyValueStorage.removeItem(noticeKey(jobId));
  } catch {
    // best-effort: a stale mapping only costs a harmless extra cancel next sync
  }
}

/**
 * Schedule the local "due" notice for one routine, replacing any notice the
 * same job already holds, so an edit re-arms exactly one notification per job.
 * A paused routine schedules nothing and clears any held notice.
 *
 * The trigger comes from the pure `cronToTrigger` — DAILY or WEEKLY for the
 * repeating shapes, otherwise a one-shot DATE at the next fire the GATEWAY
 * reported. When neither shape nor next fire exists, nothing is scheduled
 * rather than a guess. Best-effort throughout: scheduling must never break
 * the calling flow.
 *
 * The decision comes BEFORE the retirement, because an absent read must not
 * destroy a notice a past read produced: this sync runs on every connected
 * re-arm and on every Bot Chat routine read, so one list response that omits
 * `next_run_at` for a cadence beyond the repeating shapes would otherwise
 * retire a notice nothing replaces (the house rule "absent data reads as
 * UNKNOWN", cron.ts). Only a pause — a decision — retires the held notice
 * with nothing new to schedule.
 *
 * The replacement is RECORDED before the notice it replaces is retired, one
 * step further out than the schedule: a replacement the phone refuses (no
 * permission, a throwing scheduler) returns before either, leaving the held
 * notice exactly where it was, and a crash between the two steps leaves the
 * operator one EXTRA notice — which the next reconcile sweeps — never none.
 */
async function armRoutineNotice(job: RoutineJob): Promise<void> {
  // A pause is a decision, not missing data: a paused routine's notice must
  // not survive, so it is retired up front.
  if (job.paused) {
    await cancelKnownNotice(job.id);
    return;
  }

  const { botId, title } = parseRoutineName(job.name ?? job.id);
  // A routine that names no Bot cannot be tapped into a Bot Chat, so its
  // notice would claim a destination it cannot name. Withhold it and retire
  // any notice a past sync held for the job — the notice stays honest, like
  // the pause branch above: never a tray entry that scatters to Activity.
  if (!botId) {
    await cancelKnownNotice(job.id);
    return;
  }
  const trigger = cronToTrigger(job.schedule ?? '', job.nextRunAt);
  // Honest null: no repeating shape and no next fire the gateway named. The
  // notice already held stays — retiring it here would let missing data
  // silence a routine the operator scheduled.
  if (!trigger) return;

  const data = routineNoticeData(job.id, botId);

  try {
    if (!(await ensureNotificationPermission())) return;
    // Read before the mapping is overwritten: this is the identifier the
    // retirement below has to name, and a mapping that has already been
    // replaced cannot answer it.
    const replacedId = await readKnownNotice(job.id);
    const identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: routineNoticeTitle(title),
        body: 'Open Versutus to see what it finds.',
        sound: 'default',
        data,
      },
      trigger,
    });
    // A null identifier means the schedule failed — keep no mapping behind
    // a phantom id, or the next cancel would target nothing.
    if (!identifier) return;
    await keyValueStorage.setItem(noticeKey(job.id), identifier);
    if (replacedId && replacedId !== identifier) await cancelNotice(replacedId);
  } catch {
    // best-effort: notification must never break the app flow
  }
}

/**
 * Schedule (or retire) one routine's local notice, behind this job's own
 * previous sync, so two overlapping re-arms cannot both arm the same job.
 */
export async function syncRoutineNotification(job: RoutineJob): Promise<void> {
  await serialiseSync(job.id, () => armRoutineNotice(job));
}

/**
 * Retire the routine notices the OS still holds for these jobs that are not the
 * identifier each job is persisted under — the orphans two overlapping re-arms
 * left behind, one per collision, duplicated at the fire time and retired by
 * nothing.
 *
 * Scoped to the jobs this read names, on purpose: a Bot Chat's routine read
 * carries only that Bot's environment's jobs, so sweeping the whole queue
 * against it would cancel another Bot's live notice. An orphan always belongs
 * to a job that IS being re-armed, so nothing an earlier collision leaked
 * escapes this.
 */
export async function reconcileRoutineNotices(liveJobIds: readonly string[]): Promise<void> {
  try {
    const live = new Map<string, string>();
    for (const jobId of liveJobIds) {
      const knownId = await readKnownNotice(jobId);
      if (knownId) live.set(jobId, knownId);
    }
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled.flatMap((request) => {
        const jobId = routineNoticeJobId(request);
        // A notice for a job this read never named, or the one that job is
        // persisted under, is somebody else's business.
        if (jobId === null || !live.has(jobId)) return [];
        if (live.get(jobId) === request.identifier) return [];
        return [Notifications.cancelScheduledNotificationAsync(request.identifier)];
      }),
    );
  } catch {
    // best-effort: a queue that cannot be read is a queue nothing is lost by
  }
}

/**
 * Which job one scheduled notice belongs to, read from the `kind`/`jobId`
 * payload `routineNoticeData` stamps — the only notice shape this module owns,
 * so a notice posted for something else is never mistaken for one of these.
 */
function routineNoticeJobId(request: NotificationRequest): string | null {
  const data = request.content.data;
  if (!data || data.kind !== ROUTINE_NOTICE_DATA_KIND) return null;
  return typeof data.jobId === 'string' && data.jobId.length > 0 ? data.jobId : null;
}

/**
 * Retire one routine's scheduled notice — both the OS schedule and the
 * persisted identifier. Used by delete and by pause (sync with a paused
 * job also lands here through cancelKnownNotice).
 */
export async function cancelRoutineNotification(jobId: string): Promise<void> {
  await cancelKnownNotice(jobId);
}

/**
 * Re-arm every unpaused routine's notice from one fresh gateway read.
 *
 * A routine whose cron is not one of the two repeating shapes is scheduled as
 * a one-shot DATE at the next fire the GATEWAY reported (§1a) — a trigger
 * that leaves nothing behind once it lands, so without this the routine would
 * fall silent until the operator edited it. Re-syncing from a fresh read
 * rebuilds that one-shot; the per-job chain inside syncRoutineNotification
 * keeps exactly ONE notice per job, so a re-arm can never stack a second copy
 * of a notice that is already waiting, and the reconcile that closes the
 * re-arm retires whatever an EARLIER overlap left behind.
 *
 * Paused jobs are skipped rather than cancelled: the pause already retired
 * their notice, and a stale OR re-armed notice for a paused routine is the
 * lie this module exists to avoid. Best-effort throughout — sync never
 * rejects, so a re-arm is safe to fire and forget.
 */
export async function rearmRoutineNotifications(jobs: RoutineJob[]): Promise<void> {
  const live = jobs.filter((job) => !job.paused);
  await Promise.all(live.map((job) => syncRoutineNotification(job)));
  await reconcileRoutineNotices(live.map((job) => job.id));
}
