// ─── The target's own name, and the lines it draws ────────────────
// The pure half of the Home widget's target (FUTURE-ITEMS.md §4): the one name
// the plugin entry and the widget factory have to agree on, and the few lines
// the component draws from item 4a's snapshot. Deliberately no `expo-widgets`
// and no `@expo/ui` import here: the extension bundles this module with `react`,
// `react-native` and `reanimated` stubbed out (expo-widgets/metro.config.js), so
// anything this module reaches for is something the widget cannot carry.
//
// Honesty rules this module enforces:
// - The last line always says WHEN the snapshot was written. A widget is frozen
//   between writes, and a connection word on its own would read as live.
// - The work line counts only what the snapshot recorded, and reports approvals
//   first: they are the one fact that cannot wait for the operator to dig.
// - A snapshot with no judged outcome has no result line at all, rather than a
//   placeholder claiming one.

import { formatClockTime, formatDayDivider } from '@/lib/format';
import type { ConnectionStatus } from '@/lib/gateway/types';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

/**
 * The widget's identifier. Three places have to agree on it — the `name` in the
 * plugin entry (app.json), the name handed to the widget factory (the component)
 * and the Swift struct the plugin generates from that name — and nothing but
 * `__tests__/widget-target-test.ts` checks that they do. The plugin rejects a
 * name that is not a valid Swift identifier, so this is bare word characters.
 */
export const WIDGET_NAME = 'VersutusStatus';

/**
 * The connection in the app's own words — the table `connection-badge.tsx:18-24`
 * already puts in front of the operator, repeated here rather than imported
 * because that module imports `react-native-reanimated`, which the widget bundle
 * stubs out (expo-widgets/metro.config.js). The test pins all five words, so the
 * two tables cannot drift apart in silence.
 */
const STATUS_WORDS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  pairing: 'Needs approval',
  disconnected: 'Disconnected',
};

/** The work line when the snapshot recorded no work at all. */
const NO_WORK = 'No runs in flight';

/** The stamp when the snapshot's own `writtenAt` cannot be read. */
const NO_STAMP = 'Written at an unreadable time';

/**
 * How long the badge word for `pairing` is allowed to stand on its own. The
 * write point fires while the connection-phase UI is mid-approval, and such a
 * snapshot is frozen the moment the app backgrounds — so past this window the
 * approval was either long since given or long since failed, and the badge
 * word de-legitimizes the stamp beside it.
 */
const PAIRING_FRESH_MS = 60_000;

/** The honest re-word for a stale pairing verdict: the stamp carries the truth. */
const STALE_PAIRING_REWORD = 'Approval is waiting';

/**
 * The widget's lines: what the operator reads on the home screen, in the order
 * they read them. Every line is a fact the snapshot carried — nothing here is
 * fetched and nothing is composed that the snapshot did not record.
 */
export type GlanceableWidgetLines = {
  /** The connection the app last observed, in its own words. */
  status: string;
  /** The work the snapshot recorded — approvals first, then runs in flight. */
  work: string;
  /** The newest judged outcome in its own words; absent when there was none. */
  result?: string;
  /** When all of the above was true, so a frozen snapshot says so. */
  written: string;
};

function countRuns(count: number): string {
  return `${count} run${count === 1 ? '' : 's'}`;
}

/**
 * The status line. A `pairing` verdict is the only one whose word can outlive
 * its truth: the write point fires while approval is mid-flight, the widget is
 * frozen between writes, and an approval long since given or failed must not
 * keep reading as something to do. Past the freshness window the word is
 * re-worded around the stamp — the same rule the work line's stamp already
 * enforces, extended to the one status that lied. An unreadable `now` (the
 * default argument is ahead of any code path that could hand one in, but the
 * tests render with a real clock) keeps the badge word, matching the stamp's
 * own rule that a missing clock says nothing rather than guessing.
 */
function statusLine(snapshot: GlanceableSnapshot, now: number): string {
  const word = STATUS_WORDS[snapshot.status];
  if (snapshot.status !== 'pairing') return word;
  if (!Number.isFinite(snapshot.writtenAt) || !Number.isFinite(now)) return word;
  if (now - snapshot.writtenAt < PAIRING_FRESH_MS) return word;
  return `${STALE_PAIRING_REWORD} — status as of ${formatDayDivider(snapshot.writtenAt, now)} ${formatClockTime(snapshot.writtenAt)}`;
}

/**
 * `writtenAt` is always present (snapshot.ts:48-49), but a stamp that is not a
 * finite number has no clock to read, and saying so beats printing a blank one
 * beside a live-sounding connection word.
 */
function writtenLine(at: number, now: number): string {
  if (!Number.isFinite(at)) return NO_STAMP;
  return `Written ${formatDayDivider(at, now)} ${formatClockTime(at)}`;
}

/**
 * Fold the snapshot into the lines the target draws. `now` is injectable for
 * tests and decides only how the stamp's day is named (Today / Yesterday /
 * weekday); it is never used to claim the snapshot is fresher than it is.
 *
 * The approval count is a subset of the in-flight count (snapshot.ts:105-107),
 * so the remainder is what is counted as still moving — an approval run is
 * reported once, as the thing that is waiting.
 */
export function glanceableWidgetLines(
  snapshot: GlanceableSnapshot,
  now: number = Date.now(),
): GlanceableWidgetLines {
  const stillGoing = snapshot.runsInFlight - snapshot.approvalsPending;
  const work: string[] = [];

  if (snapshot.approvalsPending > 0) {
    work.push(`${countRuns(snapshot.approvalsPending)} waiting on your approval`);
  }
  if (snapshot.routineAlerts > 0) {
    work.push(
      `${snapshot.routineAlerts} routine${snapshot.routineAlerts === 1 ? '' : 's'} failing`,
    );
  }
  if (stillGoing > 0) work.push(`${countRuns(stillGoing)} in flight`);
  if (snapshot.overdueRoutines > 0) {
    work.push(
      `${snapshot.overdueRoutines} routine${snapshot.overdueRoutines === 1 ? '' : 's'} overdue`,
    );
  }

  return {
    // The one status whose word can outlive its truth: `pairing` is frozen in a
    // backgrounded widget, so past the freshness window it is re-worded to say
    // when it was true. Every other word describes a state the widget's own
    // stamp already qualifies, and an unreadable stamp re-words to nothing —
    // the badge word stands, as it does today.
    status: statusLine(snapshot, now),
    work: work.length > 0 ? work.join(' · ') : NO_WORK,
    // Absent rather than empty: a snapshot with nothing judged yet has no
    // result, and an empty line would read as one.
    ...(snapshot.lastResult ? { result: snapshot.lastResult } : {}),
    written: writtenLine(snapshot.writtenAt, now),
  };
}
