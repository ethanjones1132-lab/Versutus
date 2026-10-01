import * as Haptics from 'expo-haptics';

/**
 * Runs one native haptic and forgets whatever it does. The rejection is the
 * known case (`UnavailabilityError('Haptic', …)`, `ReactContextLost`); the
 * `try` is for the call that throws before it returns a promise, which the
 * same `await`/`void` call sites would otherwise surface to the handler.
 */
function safeHaptic(call: () => Promise<void>): Promise<void | undefined> {
  try {
    return Promise.resolve(call()).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

/**
 * Central safe haptic vocabulary. Web, low-power mode, and some emulators may
 * ignore haptics; interaction feedback must never make an action fail.
 */
export const haptics = {
  selection: () => safeHaptic(() => Haptics.selectionAsync()),
  light: () => safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  medium: () => safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => safeHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => safeHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => safeHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
