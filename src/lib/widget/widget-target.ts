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
  if (stillGoing > 0) work.push(`${countRuns(stillGoing)} in flight`);

  return {
    status: STATUS_WORDS[snapshot.status],
    work: work.length > 0 ? work.join(' · ') : NO_WORK,
    // Absent rather than empty: a snapshot with nothing judged yet has no
    // result, and an empty line would read as one.
    ...(snapshot.lastResult ? { result: snapshot.lastResult } : {}),
    written: writtenLine(snapshot.writtenAt, now),
  };
}
