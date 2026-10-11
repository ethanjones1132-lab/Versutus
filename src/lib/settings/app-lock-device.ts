// ─── The device side of the app lock ──────────────────────────────
// The one seam that touches `expo-local-authentication`, kept off the pure
// rules in `app-lock.ts` so they can be tested without a device. Both the lock
// gate and the settings switch ask here, so the app and the surface that turns
// it on cannot disagree about what this device can do.

import * as LocalAuthentication from 'expo-local-authentication';

import {
  appLockUnavailableReason,
  loadAppLock,
  type AppLockUnavailableReason,
} from '@/lib/settings/app-lock';

/**
 * What this device holds: the stored opt-in, and whether the device can answer
 * the biometric question at all. `reason === null` with `enabled` true is the
 * only state that locks — a stored flag on a device that can no longer answer
 * unlocks rather than sealing the operator out.
 */
export type AppLockState = {
  enabled: boolean;
  reason: AppLockUnavailableReason | null;
};

/**
 * The stored opt-in read against what this device can actually do. A flag the
 * store refuses to give up is held as on when the device can answer the biometric
 * prompt: the operator unlocks with Face ID, a fingerprint or the passcode, so
 * that fails closed without sealing anyone out. A device that cannot answer
 * keeps the lock off, as it always has.
 */
export async function deviceAppLockState(): Promise<AppLockState> {
  let stored: boolean | null;
  try {
    stored = await loadAppLock();
  } catch {
    stored = null;
  }
  const reason = await deviceAppLockUnavailableReason();
  if (stored === null) return { enabled: reason === null, reason };
  return { enabled: stored, reason };
}

/**
 * Ask the platform whether the lock could be used here. A platform without the
 * native module (web) throws rather than answering, and a question that cannot
 * be answered is 'unsupported' — never a lock that could not be lifted.
 */
export async function deviceAppLockUnavailableReason(): Promise<AppLockUnavailableReason | null> {
  try {
    const [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return appLockUnavailableReason(hasHardware, enrolled);
  } catch {
    return 'unsupported';
  }
}
