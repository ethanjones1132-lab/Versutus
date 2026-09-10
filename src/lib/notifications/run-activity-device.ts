// ─── The device side of a run's Live Activity ──────────────────────────────
// The one file that names the activity's component module, kept off the rules in
// `run-activity.ts` the way `widget-device.ts` is kept off `widget-target.ts`.
//
// Importing that module builds the activity on the spot: `createLiveActivity`
// returns `new LiveActivityFactory(name, layout)`
// (expo-widgets/build/Widgets.js:146-148, 100-105), whose constructor reaches for
// the native side, and on iOS that side is loaded with
// `requireNativeModule('ExpoWidgets')` (ExpoWidgets.ios.js:2), which THROWS where
// there is no native module — Expo Go, and any client built before item 4 landed
// that dependency. A static import would therefore take the app down at boot
// rather than let the caller ask the question, so the module is imported on the
// first sync instead. A load that fails is no activity at all, never a rejection
// into the caller; that is the whole reason this module exists apart from the
// seam, and it is also why the seam is async.
//
// Only iOS is answered with a factory. Item 7's Android half is the ongoing
// notice item 7b already posts (`local.ts`, `notifyRunProgress`), and one run
// gets one surface: a Lock Screen activity beside a tray notice for the same run
// would be two. Every other platform is answered before anything is imported.

import type { LiveActivity } from 'expo-widgets';
import { Platform } from 'react-native';

import { runActivityStep, type RunActivityProps } from '@/lib/notifications/run-activity';
import type { RunProgressNotice } from '@/lib/notifications/run-progress';

/** The activity this build registers, read off the component's own export. */
export type RunActivityTarget = typeof import('@/components/widget/run-live-activity');

/** One activity this process started, and the last props it wrote to it. */
type HeldActivity = {
  instance: LiveActivity<RunActivityProps>;
  /** The fold's own final props: what an ending hands the activity back. */
  props: RunActivityProps;
};

/**
 * What this process has on the Lock Screen, one entry per run.
 *
 * Nothing here outlives the process, and the Lock Screen does — which is what
 * the sweep in `syncRunActivities` is for: an instance this map does not hold is
 * one nothing in this process will ever update or end.
 */
const held = new Map<string, HeldActivity>();

/** Whether this process has already squared the Lock Screen with its own runs. */
let swept = false;

/**
 * The activity this build carries, or null when it carries none.
 *
 * `load` is the module's own import and is injectable only so the failure path
 * can be exercised without a build that lacks the native side; a load that
 * throws is the same answer as a platform with no activity target — the caller
 * is handed nothing rather than an activity whose every write could only fail.
 */
export async function loadRunActivityTarget(
  load: () => Promise<RunActivityTarget> = () => import('@/components/widget/run-live-activity'),
): Promise<RunActivityTarget | null> {
  if (Platform.OS !== 'ios') return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/**
 * End every instance on the Lock Screen this process did not start, once.
 *
 * A killed app leaves its activity behind claiming liveness it no longer has —
 * ActivityKit keeps it until something ends it, and a process that never comes
 * back never does. Nothing in an instance says which run it belonged to (the
 * factory matches on the activity's own name, not on its content —
 * ios/LiveActivityFactory.swift:40-43), so an instance this process does not
 * hold is ended outright rather than guessed at. It runs after the rows below
 * have been synced, so the activities for runs still in flight are the
 * process's own by then and are left alone. `'immediate'`, because this process
 * has no earlier reading of its own to leave as a final one: the activity is
 * being taken off the Lock Screen, not narrated.
 *
 * The sweep is marked done only when the whole of it landed, so a device that
 * refuses it is asked again on the next pass rather than for the rest of the
 * process (the channel in `local.ts:245-256` retries the same way).
 */
async function sweepOnce(target: RunActivityTarget): Promise<void> {
  if (swept) return;
  try {
    const ours = new Set([...held.values()].map((entry) => entry.instance.getId()));
    for (const instance of target.default.getInstances()) {
      if (ours.has(instance.getId())) continue;
      await instance.end('immediate');
    }
    swept = true;
  } catch {
    // The Lock Screen keeps what it has, and the next pass asks again.
  }
}

/**
 * Hand one pass of run rows to the device: start, update or end each run's
 * activity, then take anything this process is not following off the Lock
 * Screen.
 *
 * The write point's whole iOS half — the rows are item 7a's folds, folded by the
 * caller from the run state the provider already holds, and this function
 * decides nothing about them: `runActivityStep` answers start for a run in
 * flight this process is not yet following, update for one it is, end for one
 * that has settled, and nothing for a run that settled before this process ever
 * saw it.
 *
 * Best-effort, row by row, like every other write in §7: a device that refuses
 * one call must not fail a run's settle, and must not take the rest of the pass
 * down with it. Nothing is read back that a caller could act on.
 */
export async function syncRunActivities(
  notices: RunProgressNotice[],
  load: () => Promise<RunActivityTarget> = () => import('@/components/widget/run-live-activity'),
): Promise<void> {
  const target = await loadRunActivityTarget(load);
  if (!target) return;

  const live = new Set<string>();
  for (const notice of notices) {
    const runId = notice.data.runId;
    const step = runActivityStep(notice, held.has(runId));
    if (step.edge === 'none') continue;

    const entry = held.get(runId);
    if (step.edge === 'start') {
      try {
        const instance = target.default.start(step.props);
        live.add(runId);
        held.set(runId, { instance, props: step.props });
      } catch {
        // The Lock Screen keeps what it has.
      }
      continue;
    }
    // An `update` or an `end` is only ever asked for a run this process holds,
    // so an entry that is not here is a bug rather than a case to handle.
    if (!entry) continue;

    try {
      if (step.edge === 'end') {
        held.delete(runId);
        await entry.instance.end(undefined, entry.props);
        continue;
      }
      live.add(runId);
      entry.props = step.props;
      await entry.instance.update(step.props);
    } catch {
      // The activity keeps the reading it already holds.
    }
  }

  // A run this process holds an activity for and no longer lists is ended too,
  // so nothing is left on the Lock Screen for a run nobody is following.
  for (const [runId, entry] of [...held]) {
    if (live.has(runId)) continue;
    held.delete(runId);
    try {
      await entry.instance.end(undefined, entry.props);
    } catch {
      // best-effort, as above
    }
  }

  await sweepOnce(target);
}

/**
 * Forget what this process holds, and that it has swept. Tests only: `held` is
 * the whole of what the Lock Screen's state is derived from, and no app path may
 * drop an entry — a forgotten one is an activity nothing would ever end.
 */
export function resetRunActivitiesForTests(): void {
  held.clear();
  swept = false;
}
