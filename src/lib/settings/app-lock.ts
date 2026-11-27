// ─── The opt-in app lock ───────────────────────────────────────────
// Versutus holds gateway tokens and device identity (SecureStore), so it can
// be shut behind the device's own biometrics (FUTURE-ITEMS §P4). The lock is
// OFF unless this device was explicitly asked to hold it, and it is a DEVICE
// preference: nothing here reaches a gateway, and no gateway knows about it.
//
// Two rules keep the lock from becoming a lockout:
//   - a stored value that is not exactly `true` is off, so a half-written or
//     older blob can never turn the lock on by itself; a blob that does not
//     even parse is a lost answer rather than an off one, and a device that
//     can answer the prompt holds the cover for it (`appLockVerdictFromRaw`);
//   - a device that cannot answer the biometric question — no hardware, no
//     enrollment, or a platform without the module (web) — never locks. An
//     enrollment removed after the flag was stored therefore UNLOCKS rather
//     than sealing the operator out of their own gateway.
//
// The native probe lives in `app-lock-device.ts`; this module stays pure plus
// one key-value blob, so the rules are testable without a device. The gate's
// hold on a route it brought down is composed here too, so what the unlock
// re-opens is a rule a case can call rather than a string built in a screen.

import { Platform } from 'react-native';

import { keyValueStorage } from '@/lib/storage/key-value';

export const APP_LOCK_STORAGE_KEY = 'versutus:app-lock';

export const APP_LOCK_LABEL = 'App lock';

/**
 * What the device's own prompt actually asks for, in the words each platform
 * uses. iOS offers Face ID with the passcode as its fallback; Android's
 * biometric prompt covers a fingerprint, face or the device's screen lock.
 * Platform.OS decides by default, so every caller that says nothing keeps the
 * copy its own platform promises.
 */
export function appLockBiometricCopy(platform: string = Platform.OS): string {
  return platform === 'ios' ? 'Face ID or your passcode' : 'your fingerprint, face or screen lock';
}

/** The Settings row's one line, per platform. */
export function appLockSummaryFor(platform: string = Platform.OS): string {
  return `Ask for ${appLockBiometricCopy(platform)} when Versutus opens. Kept on this device.`;
}

/** The cover's one line while the app is shut, per platform. */
export function appLockCoverBodyFor(platform: string = Platform.OS): string {
  return `Unlock with ${appLockBiometricCopy(platform)} to reach your gateways.`;
}

export const APP_LOCK_SUMMARY = appLockSummaryFor();

export const APP_LOCK_COVER_TITLE = 'Versutus is locked';

export const APP_LOCK_COVER_BODY = appLockCoverBodyFor();

export const APP_LOCK_UNLOCK_LABEL = 'Unlock';

/** Why this device cannot hold the lock. Null means it can. */
export type AppLockUnavailableReason = 'unsupported' | 'not-enrolled';

/**
 * A presented route's query, as expo-router hands it over: a repeated param
 * arrives as an array and an absent one as undefined.
 */
export type HeldRouteQuery = Record<string, undefined | string | string[]>;

/**
 * Read the stored opt-in. Only a stored `true` is on — absent, false, or a
 * truthy-but-not-true value all read as off, so junk cannot enable a lock the
 * operator never asked for.
 */
export function appLockFromStored(value: unknown): boolean {
  return value === true;
}

/**
 * Whether the device can answer the biometric prompt at all. No hardware and
 * an empty enrollment are different facts, and both are stated — the operator
 * who has a fingerprint sensor but never enrolled needs a different line than
 * one holding a device that cannot ask.
 */
export function appLockUnavailableReason(
  hasHardware: boolean,
  enrolled: boolean,
): AppLockUnavailableReason | null {
  if (!hasHardware) return 'unsupported';
  if (!enrolled) return 'not-enrolled';
  return null;
}

/**
 * The one line each reason prints where the switch cannot go. Same platform
 * split as the summary: an Android phone has no Face ID to offer, and an iPhone
 * has no fingerprint reader on the models this app targets.
 */
export function appLockUnavailableCopy(
  reason: AppLockUnavailableReason,
  platform: string = Platform.OS,
): string {
  if (platform === 'ios') {
    return reason === 'not-enrolled'
      ? 'No Face ID or fingerprint is enrolled on this device. Enroll one in the device settings to use the lock.'
      : 'This device cannot ask for Face ID or a fingerprint.';
  }
  return reason === 'not-enrolled'
    ? 'No fingerprint, face or screen lock is set on this device. Set one up in the device settings to use the lock.'
    : 'This device cannot check your fingerprint, face or screen lock.';
}

/**
 * The link the lock holds for the unlock to re-open: a presented route's own
 * path with its own query, in one string, so a route brought down while the
 * lock was up comes back AS THE LINK ASKED for it — the add sheet's prefill is
 * its query, and a path alone would re-open it blank.
 *
 * A param is carried only as a non-empty string, the rule `deepLinkTarget`
 * already applies to a link's own query, and the pairs are ordered, so one
 * route is one string whatever order the router handed its params over in.
 */
export function heldRouteHref(pathname: string, query: HeldRouteQuery): string {
  const search = Object.keys(query)
    .sort()
    .flatMap((key): string[] => {
      const value = query[key];
      if (typeof value !== 'string' || value.length === 0) return [];
      return [`${encodeURIComponent(key)}=${encodeURIComponent(value)}`];
    })
    .join('&');
  return search ? `${pathname}?${search}` : pathname;
}

/** What a read of the stored opt-in settles on. */
export type AppLockVerdict = 'on' | 'off' | 'unknown';

/**
 * Classify one raw read of the stored opt-in. Nothing stored is the one shape
 * that plainly reads off — the lock is opt-in, and an absent blob was never a
 * yes. A blob that parses hands the verdict to `appLockFromStored`, so an
 * older or half-written-but-valid blob still cannot turn the lock on by
 * itself. A blob that does not parse at all is `unknown`: the answer the
 * switch once gave is LOST, not negative, and the caller decides — the device
 * seam holds the cover for a lost answer on a device that can lift it.
 */
export function appLockVerdictFromRaw(raw: string | null): AppLockVerdict {
  if (raw === null) return 'off';
  try {
    return appLockFromStored(JSON.parse(raw) as unknown) ? 'on' : 'off';
  } catch {
    return 'unknown';
  }
}

/**
 * The stored opt-in VERDICT, for the caller who has to tell a lost answer
 * apart from an absent flag. Same seam as `loadAppLock`: absent reads off by
 * the opt-in rule, a read the store refuses rejects rather than reading as
 * off, and a blob that does not parse reads unknown instead of off.
 */
export async function loadAppLockVerdict(): Promise<AppLockVerdict> {
  return appLockVerdictFromRaw(await keyValueStorage.getItem(APP_LOCK_STORAGE_KEY));
}

/**
 * Read this device's stored opt-in. Absent and corrupt both read as off. A read
 * the store refuses THROWS rather than reading as off: a refused read is not an
 * absent flag, and the caller has to be able to tell the two apart so a device
 * that can authenticate fails closed (see `deviceAppLockState`).
 */
export async function loadAppLock(): Promise<boolean> {
  return (await loadAppLockVerdict()) === 'on';
}

const listeners = new Set<() => void>();

/**
 * Subscribe to opt-in changes; returns the unsubscribe. The lock gate lives for
 * the whole process, so without a channel a switch written from Settings could
 * not reach it and the switch would only take effect at the next cold start.
 */
export function subscribeAppLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Store this device's opt-in. Written as a JSON boolean rather than a delete
 * on the way off, so the stored shape never depends on which value came last.
 * Subscribers are notified on the way out whatever the write did, so the gate
 * re-reads the flag itself rather than trusting the value handed to the switch.
 *
 * The outcome is returned, as `saveWidgetResultHidden` does: a write the store
 * refused leaves the flag where it was, so the Settings switch has to go back
 * to that value and name the refusal rather than keep claiming a lock this
 * phone does not hold. A failed write is still not a lockout — it means the
 * lock is off, which is the safe direction.
 */
export async function saveAppLock(enabled: boolean): Promise<boolean> {
  let stored = false;
  try {
    await keyValueStorage.setItem(APP_LOCK_STORAGE_KEY, JSON.stringify(appLockFromStored(enabled)));
    stored = true;
  } catch {
    // best-effort: a failed write means the lock is off, never a lockout.
  } finally {
    for (const listener of listeners) listener();
  }
  return stored;
}
