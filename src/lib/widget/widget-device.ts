// ─── The device side of the glanceable widget ──────────────────────────────
// The one file that names the widget's component module, kept off the rules in
// `widget-target.ts` the way `speech-device.ts` is kept off `speech.ts`.
//
// Importing that module builds the widget on the spot: `createWidget` returns
// `new Widget(name, layout)` (expo-widgets/build/Widgets.js:138-140), whose
// constructor reaches for the native side, and on iOS that side is loaded with
// `requireNativeModule('ExpoWidgets')` (ExpoWidgets.ios.js:2), which THROWS
// where there is no native module — Expo Go, and any client built before this
// dependency landed. A static import would therefore take the app down at boot
// rather than let the caller ask the question, so the module is imported on the
// first call instead. A load that fails is no widget at all, never a rejection
// into the caller; that is the whole reason this module exists apart from the
// seam, and it is also why the seam is async.
//
// iOS draws through expo-widgets. Android draws through `modules/versutus-widget`,
// this repo's own Glance module, which the app writes a payload to rather than a
// snapshot. Every other platform is answered before any import, so the seam hands
// each platform the one target it carries and nothing else.
//
// The seam also ANSWERS each write. `setPayload` refuses a payload the card could
// not draw, and a module that is absent refuses everything; neither is the app's
// own failure, but both mean the card kept whatever it held before, so the write
// gate must not charge them against its floor and must be told to try again.
// Every write goes through ONE queue for the same reason: two fact changes inside
// a single `import()` window are two native hops with no order between them, and
// the card must not be left holding the older snapshot.

import { Platform } from 'react-native';

import { keyValueStorage } from '@/lib/storage/key-value';
import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

/**
 * The payload JSON the app last wrote, kept beside the card's own storage.
 * A companion push carries only the work line, so this is the base the headless
 * task merges onto (see `widget-push-task.ts`). Best-effort throughout: losing it
 * costs the merge its roster, never a write that already went out.
 */
export const WIDGET_LAST_PAYLOAD_KEY = 'versutus:widget-last-payload';

/** The iOS widget this build registers (expo-widgets). */
export type WidgetTarget = typeof import('@/components/widget/glanceable-widget');

/** The Android widget module this build carries (modules/versutus-widget). */
export type AndroidWidgetModule = typeof import('../../../modules/versutus-widget').default;

/** iOS only: the expo-widgets target, or null. Android draws natively (see below). */
export async function loadWidgetTarget(
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
): Promise<WidgetTarget | null> {
  if (Platform.OS !== 'ios') return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/** Android only: the Glance widget module, or null where the build lacks it. */
export async function loadAndroidWidgetModule(
  load: () => Promise<AndroidWidgetModule> = async () => (await import('../../../modules/versutus-widget')).default,
): Promise<AndroidWidgetModule | null> {
  if (Platform.OS !== 'android') return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/**
 * Hand the widget its next snapshot, and answer whether it took it. `false`
 * means the card still holds what it held before: no widget target on this
 * build, a write that threw, or a native module that refused the payload.
 *
 * Writes are serialised, latest wins: while one is in flight only the NEWEST
 * further snapshot is kept, and any older one still waiting is refused without
 * being written, so an older snapshot can never land after a newer one.
 */
export function writeWidgetSnapshot(
  snapshot: GlanceableSnapshot,
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
  loadAndroid: () => Promise<AndroidWidgetModule> = async () => (await import('../../../modules/versutus-widget')).default,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueueWidgetJob({
      kind: 'write',
      run: () => performWidgetWrite(snapshot, load, loadAndroid),
      resolve,
    });
  });
}

/**
 * Forget the card: no gateway, no snapshot to draw, so the native `clearPayload`
 * exists for exactly this and had no caller. Queued behind the writes it retires
 * (a payload written after the clear would describe a gateway that is gone) and it
 * drops the merge's base with it.
 */
export function clearWidgetSnapshot(
  loadAndroid: () => Promise<AndroidWidgetModule> = async () => (await import('../../../modules/versutus-widget')).default,
): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueueWidgetJob({
      kind: 'clear',
      run: async () => {
        await clearWidgetCard(loadAndroid);
        return true;
      },
      resolve: () => resolve(),
    });
  });
}

/** The payload JSON the app last wrote here, or null when it has written none. */
export async function readLastWidgetPayload(): Promise<string | null> {
  try {
    return await keyValueStorage.getItem(WIDGET_LAST_PAYLOAD_KEY);
  } catch {
    return null;
  }
}

/** Keep the payload JSON as the merge's base; never throws, never fails a write. */
export async function saveLastWidgetPayload(json: string): Promise<void> {
  try {
    await keyValueStorage.setItem(WIDGET_LAST_PAYLOAD_KEY, json);
  } catch {
    // The card already has the payload; only the merge loses its base.
  }
}

/** Forget the merge's base. Best-effort, like `saveLastWidgetPayload`. */
export async function forgetLastWidgetPayload(): Promise<void> {
  try {
    await keyValueStorage.removeItem(WIDGET_LAST_PAYLOAD_KEY);
  } catch {
    // A stale base costs the merge its roster for one message, nothing more.
  }
}

type WidgetJob = {
  run: () => Promise<boolean>;
  resolve: (accepted: boolean) => void;
  /**
   * A clear is never coalesced away: dropping it would leave the very card it
   * was called to retire standing on the home screen.
   */
  kind: 'write' | 'clear';
};

const widgetJobs: WidgetJob[] = [];
let pumpingWidgetJobs = false;

function enqueueWidgetJob(job: WidgetJob): void {
  if (job.kind === 'write') {
    for (let index = widgetJobs.length - 1; index >= 0; index -= 1) {
      if (widgetJobs[index].kind !== 'write') continue;
      widgetJobs[index].resolve(false);
      widgetJobs.splice(index, 1);
      break;
    }
  }
  widgetJobs.push(job);
  void pumpWidgetJobs();
}

async function pumpWidgetJobs(): Promise<void> {
  if (pumpingWidgetJobs) return;
  pumpingWidgetJobs = true;
  try {
    for (let job = widgetJobs.shift(); job; job = widgetJobs.shift()) {
      let accepted = false;
      try {
        accepted = (await job.run()) === true;
      } catch {
        // The widget keeps the snapshot it already holds.
        accepted = false;
      }
      job.resolve(accepted);
    }
  } finally {
    pumpingWidgetJobs = false;
  }
}

async function performWidgetWrite(
  snapshot: GlanceableSnapshot,
  load: () => Promise<WidgetTarget>,
  loadAndroid: () => Promise<AndroidWidgetModule>,
): Promise<boolean> {
  if (Platform.OS === 'android') {
    const module = await loadAndroidWidgetModule(loadAndroid);
    if (!module) return false;
    const json = JSON.stringify(androidWidgetPayload(snapshot));
    let accepted: boolean;
    try {
      accepted = (await module.setPayload(json)) === true;
    } catch {
      return false;
    }
    if (accepted) await saveLastWidgetPayload(json);
    return accepted;
  }
  const target = await loadWidgetTarget(load);
  if (!target) return false;
  try {
    target.default.updateSnapshot(snapshot);
  } catch {
    return false;
  }
  return true;
}

async function clearWidgetCard(loadAndroid: () => Promise<AndroidWidgetModule>): Promise<void> {
  const module = await loadAndroidWidgetModule(loadAndroid);
  try {
    await module?.clearPayload();
  } catch {
    // Nothing left to draw and nothing to retry: the card redraws its empty state.
  }
  await forgetLastWidgetPayload();
}
