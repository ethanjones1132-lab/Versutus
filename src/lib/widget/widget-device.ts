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
// Web and Android are answered before anything is imported: the plugin's
// Android half is opt-in and this repo's entry does not enable it
// (expo-widgets/plugin/build/withWidgets.js:11), so no build name but iOS has a
// widget target for this to hand back.

import { Platform } from 'react-native';

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
  if (Platform.OS !== 'ios') return null;
  try {
    return await load();
  } catch {
    return null;
  }
}
