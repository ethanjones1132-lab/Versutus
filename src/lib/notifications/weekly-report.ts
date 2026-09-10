// ─── The weekly operator report: ONE scheduled local notice ──────────────
// D3's weekly report (FUTURE-ITEMS.md §D3 Build 4/5). A sibling of
// routine-sync.ts, not a tenant of it: routine notices are one per job and
// are rebuilt from every routine read, while this is a single app-wide notice
// the operator turns on from the scorecard surface, so it keeps its own
// module and its own stored state. The immediate notices in local.ts stay on
// `trigger: null` and are untouched by anything here.
//
// Honesty rule: the notice says the report is ready and counts nothing — it
// fires at its scheduled time whether or not the gateway ran. Nothing here is
// push: the schedule is the device's own.

import * as Notifications from 'expo-notifications';

import { keyValueStorage } from '@/lib/storage/key-value';
import {
  isWeeklyReportEnabled,
  WEEKLY_REPORT_NOTICE_BODY,
  WEEKLY_REPORT_NOTICE_KEY,
  WEEKLY_REPORT_NOTICE_TITLE,
  WEEKLY_REPORT_OPT_IN_KEY,
  WEEKLY_REPORT_OPT_IN_ON,
  weeklyReportTrigger,
} from './weekly-report-schedule';

/**
 * The opt-in state this device holds: the stored flag, absent meaning off.
 * A read that fails reads as off — the fail-closed direction, because this
 * device must hold no opt-in it cannot prove.
 */
export async function loadWeeklyReportOptIn(): Promise<boolean> {
  try {
    return isWeeklyReportEnabled(await keyValueStorage.getItem(WEEKLY_REPORT_OPT_IN_KEY));
  } catch {
    return false;
  }
}

/**
 * The identifier of the notice this device holds, or null. A locked store
 * reads as none, which is the same landing as a device that never opted in.
 */
async function knownNoticeId(): Promise<string | null> {
  try {
    return await keyValueStorage.getItem(WEEKLY_REPORT_NOTICE_KEY);
  } catch {
    return null;
  }
}

/**
 * Retire the held notice — the OS schedule and the persisted identifier —
 * best-effort: a vanished schedule or a locked store must never block the
 * opt-out the operator asked for.
 */
async function cancelHeldNotice(): Promise<void> {
  const held = await knownNoticeId();
  if (held) {
    try {
      await Notifications.cancelScheduledNotificationAsync(held);
    } catch {
      // best-effort
    }
  }
  try {
    await keyValueStorage.removeItem(WEEKLY_REPORT_NOTICE_KEY);
  } catch {
    // best-effort: a stale mapping only costs a harmless extra cancel next time
  }
}

/**
 * Ask for notification permission. Not cached for the life of the process,
 * unlike the routine modules: those sync many jobs in one pass, while this
 * runs on one operator toggle — and a cached grant would let a permission
 * revoked in Settings still read as given.
 */
async function ensurePermission(): Promise<boolean> {
  try {
    const settings = await Notifications.requestPermissionsAsync();
    return settings.granted;
  } catch {
    return false;
  }
}

/**
 * Apply the opt-in: schedule or retire the one weekly notice, and answer with
 * the state now in force.
 *
 * OFF retires the held notice and clears the flag — the operator asked for
 * silence, so a notice that outlived its own opt-out would be the lie this
 * module exists to avoid.
 *
 * ON asks for permission and schedules exactly one notice, retiring a notice
 * the same state already held only once a replacement has landed: a declined
 * permission or a failed schedule leaves a working reminder in place rather
 * than trading it for nothing. And it holds NO flag it cannot honour — a
 * scheduled notice that never landed must not read as "on" in the toggle, so
 * the answer is the state this device actually holds.
 */
export async function setWeeklyReportOptIn(enabled: boolean): Promise<boolean> {
  if (!enabled) {
    await cancelHeldNotice();
    try {
      await keyValueStorage.removeItem(WEEKLY_REPORT_OPT_IN_KEY);
    } catch {
      // best-effort: the notice is already retired, which is the operator's ask
    }
    return false;
  }

  if (!(await ensurePermission())) return loadWeeklyReportOptIn();

  const held = await knownNoticeId();
  let identifier: string | null;
  try {
    identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: WEEKLY_REPORT_NOTICE_TITLE,
        body: WEEKLY_REPORT_NOTICE_BODY,
        sound: 'default',
      },
      trigger: weeklyReportTrigger(),
    });
  } catch {
    // best-effort: notification must never break the app flow
    return loadWeeklyReportOptIn();
  }

  // No identifier means no notice — keep no mapping and no flag behind it, so
  // the surface cannot promise a report nothing will announce.
  if (!identifier) return loadWeeklyReportOptIn();

  try {
    await keyValueStorage.setItem(WEEKLY_REPORT_NOTICE_KEY, identifier);
  } catch {
    // The notice is scheduled either way; without the mapping the next opt-out
    // cannot retire it by id, which is the cost of a locked store, not a lie.
  }
  if (held && held !== identifier) {
    try {
      await Notifications.cancelScheduledNotificationAsync(held);
    } catch {
      // best-effort: a replaced notice still sitting in the tray is cosmetic
    }
  }

  try {
    await keyValueStorage.setItem(WEEKLY_REPORT_OPT_IN_KEY, WEEKLY_REPORT_OPT_IN_ON);
    return true;
  } catch {
    return loadWeeklyReportOptIn();
  }
}
