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

import { Platform } from 'react-native';

import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

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
 * Hand the widget its next snapshot, or nothing. A refusing write is swallowed:
 * the widget keeps the last snapshot it holds and says when that was.
 */
export async function writeWidgetSnapshot(
  snapshot: GlanceableSnapshot,
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
  loadAndroid: () => Promise<AndroidWidgetModule> = async () => (await import('../../../modules/versutus-widget')).default,
): Promise<void> {
  if (Platform.OS === 'android') {
    const module = await loadAndroidWidgetModule(loadAndroid);
    try {
      await module?.setPayload(JSON.stringify(androidWidgetPayload(snapshot)));
    } catch {
      // The widget keeps the snapshot it already holds.
    }
    return;
  }
  const target = await loadWidgetTarget(load);
  try {
    target?.default.updateSnapshot(snapshot);
  } catch {
    // The widget keeps the snapshot it already holds.
  }
}
