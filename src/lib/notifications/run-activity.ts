// ─── A run's Live Activity (FUTURE-ITEMS.md §7's iOS half) ─────────────────
// The pure half of §7's iOS surface: the name the activity is registered under,
// the props its banner draws, and the edge — start, update, end, or nothing —
// that one of item 7a's folds asks the device for.
//
// Every prop is a reading item 7a already phrased: the state line it chose for
// the run, the elapsed span it measured, the newest step it read off the row,
// and the absolute clock it folded at. Nothing here composes a word of its own,
// and nothing here reaches the device — `run-activity-device.ts` is that seam,
// and it is the only file that names the component. The one import is a type, so
// the widget extension's bundle can carry this module beside the component
// without pulling `expo-notifications` in behind it.

import type { RunProgressNotice } from './run-progress';

/**
 * The name the component registers the factory under.
 *
 * Unlike the Home widget's, this name is in no app config: the plugin's
 * generated `WidgetLiveActivity` reads the layout of the activity it is drawing
 * out of that activity's own state (ios/Widgets/WidgetLiveActivity.swift:21-34,
 * keying `WidgetsStorage` by `context.state.name`), and the factory writes
 * exactly this string under it (ios/LiveActivityFactory.swift:13-16) — so the
 * two halves meet here and nowhere else, and a second literal anywhere would be
 * a second name to keep in step.
 */
export const RUN_ACTIVITY_NAME = 'VersutusRunActivity';

/**
 * What the banner draws, and all it draws: item 7a's lines, verbatim.
 */
export type RunActivityProps = {
  /** 'Run in progress' or 'Run needs approval' — the state the run is in. */
  status: string;
  /** 'Elapsed 3:42' — the span this device watched, when it can be read as one. */
  elapsed?: string;
  /** The newest step the run stream delivered, when it delivered words. */
  step?: string;
  /** 'Last update 14:02' — when all of the above was true, in this device's clock. */
  updated: string;
};

/**
 * The props for one run's activity, taken from the notice that run already has.
 *
 * A `retire` carries no copy at all — §7's ending is `notifyRunComplete`'s to
 * say, and this fold authors no second set of words for one — so there is
 * nothing to hand an activity there; a caller holding an activity for a run that
 * has settled keeps the last props it wrote, which is what it ends with. This
 * function therefore only ever answers for an `update`.
 */
export function runActivityProps(
  notice: Extract<RunProgressNotice, { verb: 'update' }>,
): RunActivityProps {
  const { elapsed, step, updated } = notice.lines;
  return {
    status: notice.title,
    ...(elapsed ? { elapsed } : {}),
    ...(step ? { step } : {}),
    updated,
  };
}

/** What one pass asks the device for, per run. */
export type RunActivityStep =
  | { edge: 'start'; props: RunActivityProps }
  | { edge: 'update'; props: RunActivityProps }
  | { edge: 'end' }
  | { edge: 'none' };

/**
 * The edge this fold asks for, given whether the process already holds an
 * activity for that run.
 *
 * A run in flight starts one the first time it is folded and updates it from
 * then on, so a run watched for an hour leaves one activity on the Lock Screen
 * rather than a stack of them. A settled run ends — and a run already over is
 * never started: an activity begun at the settle would be a second surface
 * announcing an ending the completion notice has already said, and one nothing
 * would ever take off the Lock Screen.
 */
export function runActivityStep(notice: RunProgressNotice, held: boolean): RunActivityStep {
  if (notice.verb === 'update') {
    return { edge: held ? 'update' : 'start', props: runActivityProps(notice) };
  }
  return held ? { edge: 'end' } : { edge: 'none' };
}
