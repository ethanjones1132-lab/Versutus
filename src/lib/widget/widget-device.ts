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
// iOS and Android carry a widget target, and every other platform is answered
// null before anything is imported. The plugin's Android half is opt-in
// (expo-widgets/plugin/build/withWidgets.js:11) and this repo's entry enables
// it, so the same seam hands back a target on both platforms; Metro's platform
// resolution picks `glanceable-widget.android.tsx` where the iOS file would
// otherwise be bundled. Web has no widget target at all and is answered before
// the import that could only throw.

import { Platform } from 'react-native';

import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

/**
 * The widget this build registers, read off the component's own export the way
 * `SpeechEngine` is read off the package's.
 */
export type WidgetTarget = typeof import('@/components/widget/glanceable-widget');

/**
 * The widget this build carries, or null when it carries none.
 *
 * `load` is the module's own import and is injectable only so the failure path
 * can be exercised without a build that lacks the native side; a load that
 * throws is the same answer as a platform with no widget target — the caller is
 * handed nothing rather than a widget whose every write could only fail.
 */
export async function loadWidgetTarget(
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
): Promise<WidgetTarget | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/**
 * Hand the widget its next snapshot, or nothing.
 *
 * The seam's second half, and the only place the app writes the widget:
 * `updateSnapshot` is the instance `createWidget` returned
 * (`expo-widgets/build/Widgets.js:28-29`, one timeline entry stamped
 * `Date.now()`), and the component module's default export IS that instance, so
 * a caller reaches it exactly the way it reaches the module — through the same
 * lazy load. A device whose build carries no widget target therefore writes
 * nothing at all, and the caller cannot tell it apart from a write that landed,
 * which is the point: the app's own run lifecycle is not news the widget gets
 * to block.
 *
 * A refusing write is swallowed for the same reason a load that throws is
 * answered null: the widget holds the last snapshot it was handed and says when
 * that was (`writtenAt`), and one operator's missing native side must not fail
 * a run's settle. Nothing here reads anything back, so there is no failure the
 * caller could act on.
 */
export async function writeWidgetSnapshot(
  snapshot: GlanceableSnapshot,
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
): Promise<void> {
  const target = await loadWidgetTarget(load);
  try {
    target?.default.updateSnapshot(snapshot);
  } catch {
    // The widget keeps the snapshot it already holds.
  }
}
