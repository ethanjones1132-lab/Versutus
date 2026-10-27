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
// push: the schedule is the device's own. Its one payload marker is the kind
// that routes a tap to the scorecard surface (tap-route.ts).
//
// Bookkeeping rule (QUALITY-SCAN 2026-10-11, scan985–989): an identifier is
// forgotten only once the phone confirms that notice is not live any more, or
// once a later opt-out retires it. So an attempt records its own notice's id
// BEFORE anything that can fail, rolls back only what it created, leaves the
// held notice held, and keeps the identity of any notice it could not cancel.
// The primary mapping stays the bare single id older builds wrote; every other
// live notice is named in this module's own pending list.

import * as Notifications from 'expo-notifications';

import { keyValueStorage } from '@/lib/storage/key-value';
import {
  isWeeklyReportEnabled,
  WEEKLY_REPORT_NOTICE_BODY,
  WEEKLY_REPORT_NOTICE_KEY,
  WEEKLY_REPORT_NOTICE_TITLE,
  WEEKLY_REPORT_OPT_IN_KEY,
  WEEKLY_REPORT_OPT_IN_ON,
  weeklyReportNoticeData,
  weeklyReportTrigger,
  type WeeklyReportOptInState,
  type WeeklyReportRefusal,
} from './weekly-report-schedule';

/**
 * Storage key holding the identifiers this module must not forget beyond the
 * primary mapping: a replacement the phone refused to cancel, a notice a
 * failed attempt could not undo, and — while an attempt is in flight — the
 * notice that attempt is replacing. A JSON array of identifiers, written only
 * by `weekly-report.ts`.
 *
 * It is a separate key on purpose. `WEEKLY_REPORT_NOTICE_KEY` stays the bare
 * single id it has always been, so a device whose state an older build wrote
 * still reads — the pending list is simply absent there.
 */
export const WEEKLY_REPORT_PENDING_NOTICE_KEY = 'versutus:weekly-report-notification-pending';

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
 * The opt-in state this device holds, as a read of what it can still deliver:
 * the stored flag, and — when that flag says on — whether the phone still
 * allows notifications.
 *
 * Without the second half, an operator who opts in and then turns notifications
 * off in the OS Settings opens the app to a switch reading on for a notice the
 * tray cannot show. With it, that case lands on the same
 * `{ state: 'refused', reason: 'permission' }` an attempt the phone declined
 * lands on, so the surface's one line explains it.
 *
 * Reads only: it schedules nothing, cancels nothing, and asks the operator for
 * nothing, so a surface may call it on every mount, every return to its tab and
 * every return to the foreground — the read answers the device that is there
 * now, never a cached first answer.
 */
export async function readWeeklyReportOptIn(): Promise<WeeklyReportOptInState> {
  if (!(await loadWeeklyReportOptIn())) return { state: 'off' };
  return (await readPermissionGranted()) === false
    ? { state: 'refused', reason: 'permission' }
    : { state: 'on' };
}

/**
 * The identifier of the notice the mapping holds, or null, and whether the
 * store actually answered. The two are kept apart because they lead to
 * opposite decisions: an absent mapping may be removed, while an unreadable
 * one may name a live notice and must be left exactly where it is.
 */
async function readPrimaryNoticeId(): Promise<{ id: string | null; readable: boolean }> {
  try {
    return { id: await keyValueStorage.getItem(WEEKLY_REPORT_NOTICE_KEY), readable: true };
  } catch {
    return { id: null, readable: false };
  }
}

/**
 * The identifiers named in the pending list, and whether that record may be
 * replaced. `replaceable` is false only when the READ itself failed, because
 * the key may then name notices this call never saw; overwriting it would
 * forget them. A value that is absent, corrupt or not an array names nothing
 * recoverable, so the next write repairs it.
 */
async function readPendingNoticeIds(): Promise<{ ids: string[]; replaceable: boolean }> {
  let raw: string | null = null;
  try {
    raw = await keyValueStorage.getItem(WEEKLY_REPORT_PENDING_NOTICE_KEY);
  } catch {
    return { ids: [], replaceable: false };
  }
  if (!raw) return { ids: [], replaceable: true };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Content this module never wrote names nothing it can recover, so a later
    // write may replace it; leaving it would block every later toggle.
    return { ids: [], replaceable: true };
  }
  if (!Array.isArray(parsed)) return { ids: [], replaceable: true };

  const identifiers: string[] = [];
  for (const value of parsed as unknown[]) {
    if (typeof value === 'string' && value.length > 0) identifiers.push(value);
  }
  return { ids: identifiers, replaceable: true };
}

/**
 * Identifiers the store would not accept while the notice was live, kept for
 * this process only. The pending list is the durable record; this is the last
 * resort for a locked store, so an opt-out in the same session can still
 * retire a notice no key could name. Nothing enters it unless both the list
 * write and the cancellation were refused.
 */
const untrackedNoticeIds = new Set<string>();

/** One identifier per notice, in the order first seen. */
function uniqueNoticeIds(identifiers: Array<string | null>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const identifier of identifiers) {
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    unique.push(identifier);
  }
  return unique;
}

/**
 * Every notice this module knows may be live: the primary mapping plus the
 * pending list plus this process's untracked survivors.
 */
function trackedNoticeIds(primaryId: string | null, pendingIds: string[]): string[] {
  return uniqueNoticeIds([primaryId, ...pendingIds, ...untrackedNoticeIds]);
}

/**
 * Persist the pending identifiers, and say whether the store took them.
 * Best-effort by design — a locked store must not block the toggle — but the
 * caller has to know whether it can rely on this record, because that is what
 * decides whether a notice may be kept or must be undone.
 */
async function storePendingNoticeIds(identifiers: string[]): Promise<boolean> {
  const unique = uniqueNoticeIds(identifiers);
  try {
    if (unique.length === 0) {
      await keyValueStorage.removeItem(WEEKLY_REPORT_PENDING_NOTICE_KEY);
    } else {
      await keyValueStorage.setItem(
        WEEKLY_REPORT_PENDING_NOTICE_KEY,
        JSON.stringify(unique),
      );
    }
    for (const identifier of unique) untrackedNoticeIds.delete(identifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retire one schedule and say whether it is gone. Expo resolves when the OS
 * holds no notification under that identifier, so `true` means "not live any
 * more" — exactly what the bookkeeping needs. `false` means the identity must
 * stay recorded, because the notice may still fire.
 */
async function forgetNotice(identifier: string): Promise<boolean> {
  try {
    await Notifications.cancelScheduledNotificationAsync(identifier);
    untrackedNoticeIds.delete(identifier);
    return true;
  } catch {
    return false;
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
 * Whether the phone still allows notifications, as a READ of the permission it
 * holds now — `getPermissionsAsync`, never the request, because this decides
 * what a surface paints and must not fire a system dialog the operator did not
 * ask for. It also decides by the same field `ensurePermission` does, so the
 * read and the attempt can never disagree about the same device.
 *
 * `null` is a permission this platform cannot answer: expo rejects with an
 * `UnavailabilityError` where no permission module is installed. Nothing was
 * read there, so nothing is named — the caller keeps the state the device's own
 * record holds rather than sending the operator to Settings over a fact this
 * device never reported.
 */
async function readPermissionGranted(): Promise<boolean | null> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    return settings.granted;
  } catch {
    return null;
  }
}

/**
 * The state the stored flag says this device holds, as the opt-in vocabulary
 * names it. `loadWeeklyReportOptIn` never rejects.
 */
async function storedOptInState(): Promise<WeeklyReportOptInState> {
  return (await loadWeeklyReportOptIn()) ? { state: 'on' } : { state: 'off' };
}

/**
 * The state after an attempt that placed no new notice: ON when a notice the
 * operator already had is still waiting, and otherwise the refusal the
 * attempt met. Answering the held state rather than the reason keeps a
 * working reminder from being traded for a complaint about its replacement.
 */
async function stateAfterDecline(reason: WeeklyReportRefusal): Promise<WeeklyReportOptInState> {
  const held = await storedOptInState();
  return held.state === 'on' ? held : { state: 'refused', reason };
}

/**
 * Retire every notice this module knows may still be live — the mapping and
 * every pending identifier, including a survivor of an earlier failed attempt.
 *
 * An identifier whose cancellation the phone refuses STAYS recorded (as the
 * mapping when it was the primary, otherwise in the pending list), so it is
 * never silently left to fire: the next opt-out tries it again. Only a
 * confirmed cancellation removes an identity — a refused one is moved into the
 * pending list, never dropped.
 */
async function retireTrackedNotices(): Promise<void> {
  const primary = await readPrimaryNoticeId();
  const pending = await readPendingNoticeIds();
  const tracked = trackedNoticeIds(primary.id, pending.ids);
  const survivors: string[] = [];

  for (const identifier of tracked) {
    if (!(await forgetNotice(identifier))) survivors.push(identifier);
  }

  const survivorsBeyondPrimary = survivors.filter((identifier) => identifier !== primary.id);
  if (pending.replaceable) {
    if (!(await storePendingNoticeIds(survivorsBeyondPrimary))) {
      for (const identifier of survivorsBeyondPrimary) untrackedNoticeIds.add(identifier);
    }
  } else {
    // The list may name notices this call could not read, so overwriting it
    // would forget them. Keep only the survivors it does know, in memory.
    for (const identifier of survivorsBeyondPrimary) untrackedNoticeIds.add(identifier);
  }

  // The mapping may name only a notice that is still live. A cancelled one is
  // dropped, so a later opt-in cannot mistake it for something it still holds.
  // An unreadable mapping is left alone: it may name a notice still to retire.
  if (primary.readable && (!primary.id || !survivors.includes(primary.id))) {
    try {
      await keyValueStorage.removeItem(WEEKLY_REPORT_NOTICE_KEY);
    } catch {
      // best-effort: a stale mapping only costs a harmless extra cancel later
    }
  }
}

/**
 * Apply the opt-in: schedule or retire the one weekly notice, and answer with
 * the state now in force — and, when the device refused to hold one, the
 * reason it refused, so a surface can say why rather than leave a declined
 * attempt looking like a report nobody ever asked for.
 *
 * OFF retires every notice this module still knows is live — the held one and
 * any survivor an earlier failed attempt left behind — and clears the flag.
 * The operator asked for silence, so a notice that outlived its own opt-out
 * would be the lie this module exists to avoid.
 *
 * ON is a transaction in a fixed order, because every write below can fail.
 * It first reads the device's two records: if either cannot be read, the
 * attempt refuses without scheduling, because it cannot know what it would be
 * stacking on and must never overwrite a record it could not read.
 *
 *   1. Schedule the new notice. A throw or an empty identifier is the same
 *      refusal as before, and nothing this device held has been touched.
 *   2. Record the attempt's identity — and the identity of the notice it is
 *      replacing — in the pending list. If the store refuses, keep no notice
 *      it cannot name: undo this attempt and leave the held notice alone, so
 *      the answer is whatever that held notice still reads as.
 *   3. Record consent. If the flag cannot be written, the attempt earns
 *      nothing new; undo the notice THIS attempt created and leave the held
 *      notice exactly as it was — mapping, schedule and consent all unchanged.
 *      (When the flag was already on, the phone still holds that consent, so
 *      the held notice keeps reading on.)
 *   4. Promote the attempt's notice to the mapping. If that write fails, the
 *      notice is still live and still named by the pending list, so the device
 *      does hold what the flag now says; retire nothing, because the mapping
 *      still needs a live notice to name.
 *   5. Only now retire what step 4 superseded. A cancellation the phone
 *      refuses stays in the pending list, so it is named until a later opt-out
 *      retires it.
 *
 * No step turns a failed replacement into a consent change: the flag is only
 * ever set to on after the new notice exists, and it is only cleared by an
 * opt-out.
 */
export function setWeeklyReportOptIn(enabled: boolean): Promise<WeeklyReportOptInState> {
  // A toggle must see the preceding toggle's complete journal. Otherwise two
  // opt-ins can both read an empty journal and overwrite each other's live id,
  // or an opt-out can finish before an earlier schedule has returned its id.
  const attempt = weeklyReportAttempt.then(() => applyWeeklyReportOptIn(enabled));
  weeklyReportAttempt = attempt.then(() => undefined, () => undefined);
  return attempt;
}

let weeklyReportAttempt: Promise<void> = Promise.resolve();

async function applyWeeklyReportOptIn(enabled: boolean): Promise<WeeklyReportOptInState> {
  if (!enabled) {
    await retireTrackedNotices();
    try {
      await keyValueStorage.removeItem(WEEKLY_REPORT_OPT_IN_KEY);
    } catch {
      // best-effort: the notices are already retired, which is the operator's ask
    }
    return { state: 'off' };
  }

  const held = await readPrimaryNoticeId();
  const pending = await readPendingNoticeIds();
  if (!held.readable || !pending.replaceable) {
    // The device's own record cannot be read, so an attempt cannot know what
    // it would be stacking on. Fail closed without scheduling or prompting:
    // nothing is touched, and the unreadable record is left intact for a later
    // call to retire.
    return stateAfterDecline('schedule');
  }

  if (!(await ensurePermission())) return stateAfterDecline('permission');

  const alreadyTracked = trackedNoticeIds(held.id, pending.ids);

  let identifier: string | null;
  try {
    identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: WEEKLY_REPORT_NOTICE_TITLE,
        body: WEEKLY_REPORT_NOTICE_BODY,
        data: weeklyReportNoticeData(),
        sound: 'default',
      },
      trigger: weeklyReportTrigger(),
    });
  } catch {
    // best-effort: notification must never break the app flow
    return stateAfterDecline('schedule');
  }

  // No identifier means no notice — keep no mapping and no flag behind it, so
  // the surface cannot promise a report nothing will announce.
  if (!identifier) return stateAfterDecline('schedule');

  // Step 2: the attempt's notice must be nameable before anything else can
  // fail. The notice being replaced is recorded beside it so that, once the
  // new one is promoted, an uncancelled old one still has a name.
  const attemptIds = uniqueNoticeIds([...alreadyTracked, identifier]);
  if (!(await storePendingNoticeIds(attemptIds))) {
    // The device will not record what it holds, so it must not hold a notice it
    // cannot name. Undo only this attempt; the held notice was never touched.
    if (!(await forgetNotice(identifier))) untrackedNoticeIds.add(identifier);
    return stateAfterDecline('schedule');
  }

  // Step 3: consent. No new notice may be kept behind a flag that refused.
  try {
    await keyValueStorage.setItem(WEEKLY_REPORT_OPT_IN_KEY, WEEKLY_REPORT_OPT_IN_ON);
  } catch {
    if (await forgetNotice(identifier)) {
      // The attempt's own notice is gone, so drop its id from the record while
      // keeping every identifier the device held before this attempt.
      await storePendingNoticeIds(attemptIds.filter((id) => id !== identifier));
    }
    // If the cancellation was refused, the identifier is still in the pending
    // list and a later opt-out will retire it.
    return stateAfterDecline('schedule');
  }

  // Step 4: promote the new notice to the primary mapping.
  try {
    await keyValueStorage.setItem(WEEKLY_REPORT_NOTICE_KEY, identifier);
  } catch {
    // The notice is live, consented to, and named in the pending list; the
    // mapping still names the notice it named before, which is why nothing is
    // retired here. Both are tracked, so the later opt-out retires both.
    return { state: 'on' };
  }

  // Step 5: the new notice is the held one; retire what it superseded.
  const superseded = attemptIds.filter((id) => id !== identifier);
  const survivors: string[] = [];
  for (const supersededId of superseded) {
    if (!(await forgetNotice(supersededId))) survivors.push(supersededId);
  }
  if (!(await storePendingNoticeIds(survivors))) {
    for (const survivor of survivors) untrackedNoticeIds.add(survivor);
  }

  return { state: 'on' };
}
