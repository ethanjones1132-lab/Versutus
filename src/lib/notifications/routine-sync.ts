// ─── Scheduled routine notices: one notices per routine, persisted ──
// Routines are scheduled on the gateway as 5-field cron; this module posts
// the phone-side LOCAL notice at that time. Honesty rule (FUTURE-ITEMS §1a):
// the notice fires at the scheduled time whether or not the gateway actually
// ran — copy says "due", never a result count.
//
// Deliberately a sibling of local.ts (immediate notices) so the immediate
// paths keep their own lives: approval / run-complete / gateway-down notices
// stay on `trigger: null` and touch nothing here.

import * as Notifications from 'expo-notifications';

import {
  cronToTrigger,
  routineNoticeData,
  routineNoticeTitle,
} from './routine-schedule';
import type { RoutineJob } from '@/lib/gateway/routines';
import { parseRoutineName } from '@/lib/gateway/routines';
import { keyValueStorage } from '@/lib/storage/key-value';

let permissionGranted = false;

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

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted) return true;
  try {
    const settings = await Notifications.requestPermissionsAsync();
    permissionGranted = settings.granted;
    return permissionGranted;
  } catch {
    return false;
  }
}

/**
 * Cancel one routine's known scheduled notice and clear its persisted id,
 * best-effort: a vanished schedule or a locked store must never block the
 * sync that follows.
 */
async function cancelKnownNotice(jobId: string): Promise<void> {
  try {
    const knownId = await keyValueStorage.getItem(noticeKey(jobId));
    if (knownId) {
      await Notifications.cancelScheduledNotificationAsync(knownId);
    }
  } catch {
    // best-effort
  } finally {
    try {
      await keyValueStorage.removeItem(noticeKey(jobId));
    } catch {
      // best-effort: a stale mapping only costs a harmless extra cancel next sync
    }
  }
}

/**
 * Schedule the local "due" notice for one routine, replacing any notice the
 * same job already holds: cancel-then-schedule leaves exactly one
 * notification per job. A paused routine schedules nothing and clears any
 * held notice.
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
 */
export async function syncRoutineNotification(job: RoutineJob): Promise<void> {
  // A pause is a decision, not missing data: a paused routine's notice must
  // not survive, so it is retired up front.
  if (job.paused) {
    await cancelKnownNotice(job.id);
    return;
  }

  const { botId, title } = parseRoutineName(job.name ?? job.id);
  const trigger = cronToTrigger(job.schedule ?? '', job.nextRunAt);
  // Honest null: no repeating shape and no next fire the gateway named. The
  // notice already held stays — retiring it here would let missing data
  // silence a routine the operator scheduled.
  if (!trigger) return;

  // A replacement exists: retire the held notice, then schedule exactly one.
  await cancelKnownNotice(job.id);
  const data = routineNoticeData(job.id, botId ?? '');

  try {
    if (!(await ensurePermission())) return;
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
    if (identifier) {
      await keyValueStorage.setItem(noticeKey(job.id), identifier);
    }
  } catch {
    // best-effort: notification must never break the app flow
  }
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
 * rebuilds that one-shot; the cancel-then-schedule inside
 * syncRoutineNotification keeps exactly ONE notice per job, so a re-arm can
 * never stack a second copy of a notice that is already waiting.
 *
 * Paused jobs are skipped rather than cancelled: the pause already retired
 * their notice, and a stale OR re-armed notice for a paused routine is the
 * lie this module exists to avoid. Best-effort throughout — sync never
 * rejects, so a re-arm is safe to fire and forget.
 */
export async function rearmRoutineNotifications(jobs: RoutineJob[]): Promise<void> {
  const live = jobs.filter((job) => !job.paused);
  await Promise.all(live.map((job) => syncRoutineNotification(job)));
}
