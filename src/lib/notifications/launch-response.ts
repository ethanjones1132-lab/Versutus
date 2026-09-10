// ─── The tap that LAUNCHED the app (FUTURE-ITEMS.md §1c) ─────────────────
// A routine notice exists to be tapped while the app is closed, so the tap
// that cold-starts the process has to route as well as a tap on a running
// app. The Expo v57 notifications docs' routing recipe reads
// Notifications.getLastNotificationResponse() before it registers the
// response listener, because the response that launched the app is not
// replayed to a listener registered during boot
// (docs.expo.dev/versions/v57.0.0/sdk/notifications — "Responding to a
// notification tap"). The decision it feeds is the same routeForTap the live
// listener applies; this module only owns the read and the once-guard, so
// both stay jest-pinnable where the native module is not.
//
// Reading retires the response, so nothing in the process can route the same
// launch tap twice, and a listener response repeating the launch identifier
// inside a short window is treated as that same tap arriving again.

import * as Notifications from 'expo-notifications';

/**
 * How long after the launch tap a listener response repeating its identifier
 * counts as the same tap. A cold launch can hand the launch response to the
 * listener registered during boot, and no payload field separates a replay
 * from a fresh tap — only the identifier and how soon it arrives do. The
 * window is what keeps a repeating notice honest: expo's NotificationRequest
 * doc notes many notifications may be triggered with the same request (a
 * repeating notification), so a DAILY routine keeps ONE identifier across
 * fires and tomorrow's tap on it is a fresh tap, not a replay.
 */
export const LAUNCH_REPLAY_WINDOW_MS = 5_000;

/** The launch tap's identifier, and when the app handled it. */
export type LaunchTap = {
  identifier: string;
  at: number;
};

/**
 * The tap that launched the app, or null when there is none. Reading retires
 * it — `clearLastNotificationResponse` is synchronous in expo v57, its
 * `...Async` sibling deprecated — so a later effect in the same process can
 * never route the same launch tap again.
 *
 * Best-effort by design: a platform without the native emitter (web) throws
 * from the getter, and a boot must never crash over a notification.
 */
export function readLaunchResponse(): Notifications.NotificationResponse | null {
  try {
    const response = Notifications.getLastNotificationResponse();
    if (!response) return null;
    Notifications.clearLastNotificationResponse();
    return response;
  } catch {
    return null;
  }
}

/**
 * True when a response delivered to the live listener is the launch tap
 * arriving a second time. Armed by the launch read; the caller consumes it on
 * the first match so one tap is one navigation. A clock that went backwards
 * is not trusted — an unmeasurable gap is not a replay.
 */
export function isLaunchReplay(
  launch: LaunchTap | null,
  identifier: string,
  now: number = Date.now(),
): boolean {
  if (!launch || launch.identifier !== identifier) return false;
  const elapsed = now - launch.at;
  return elapsed >= 0 && elapsed <= LAUNCH_REPLAY_WINDOW_MS;
}
