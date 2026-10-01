/**
 * `haptics` is the repo's whole answer to a phone whose vibrator is missing:
 * every entry must resolve, whatever the native module does. Two shapes of
 * failure are covered here because `expo-haptics` produces both — an `async`
 * function that rejects (`UnavailabilityError('Haptic', 'impactAsync')` when
 * the module is absent, `ReactContextLost` / `ClassCastException` surfaced by
 * `HapticsModule.kt` when the context or the vibrator service is not there),
 * and a call that throws before it ever returns a promise.
 */
const mode = { throws: false, rejects: true };

jest.mock('expo-haptics', () => {
  const call = () => {
    if (mode.throws) throw new Error('UnavailabilityError: Haptic.impactAsync');
    if (mode.rejects) return Promise.reject(new Error('UnavailabilityError: Haptic.impactAsync'));
    return Promise.resolve(undefined);
  };
  return {
    __esModule: true,
    impactAsync: jest.fn(call),
    notificationAsync: jest.fn(call),
    selectionAsync: jest.fn(call),
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  };
});

import * as Haptics from 'expo-haptics';

import { haptics } from '@/lib/haptics';

const ENTRIES = [
  ['selection', () => haptics.selection()],
  ['light', () => haptics.light()],
  ['medium', () => haptics.medium()],
  ['success', () => haptics.success()],
  ['warning', () => haptics.warning()],
  ['error', () => haptics.error()],
] as const;

beforeEach(() => {
  mode.throws = false;
  mode.rejects = false;
  (Haptics.impactAsync as jest.Mock).mockClear();
  (Haptics.notificationAsync as jest.Mock).mockClear();
  (Haptics.selectionAsync as jest.Mock).mockClear();
});

describe('a haptic can never reject', () => {
  test.each(ENTRIES)('%s resolves when the native call rejects', async (_name, entry) => {
    mode.rejects = true;
    await expect(entry()).resolves.toBeUndefined();
  });

  test.each(ENTRIES)('%s resolves when the native call throws synchronously', async (_name, entry) => {
    mode.throws = true;
    await expect(entry()).resolves.toBeUndefined();
  });

  test('a synchronous throw is still a resolved promise, not a thrown error', () => {
    // The await form above would also pass for a function that threw into the
    // caller; the fire-and-forget form is what the repo's `void haptics.x()`
    // sites use, and a throw there is the unhandled exception.
    mode.throws = true;
    for (const [, entry] of ENTRIES) {
      expect(() => entry()).not.toThrow();
    }
  });
});

describe('a haptic that works still reaches the device', () => {
  test('each entry makes the one native call with the style it names', async () => {
    await haptics.selection();
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);

    await haptics.light();
    expect(Haptics.impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Light);

    await haptics.medium();
    expect(Haptics.impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Medium);

    await haptics.success();
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith(Haptics.NotificationFeedbackType.Success);

    await haptics.warning();
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith(Haptics.NotificationFeedbackType.Warning);

    await haptics.error();
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith(Haptics.NotificationFeedbackType.Error);

    // The styles above are what the raw call sites asked for, so no entry
    // substitutes a different one.
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(3);
  });
});
