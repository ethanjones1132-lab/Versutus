// ─── The app lock's phase, for surfaces that must wait for it ──────
// The gate's own answer about this device, exposed beside it so a surface that
// must not present over the lock can read the one verdict instead of guessing
// from the cover. It stays a separate module so a consumer does not pull the
// gate's router, storage and biometric imports in with it.

import { createContext, useContext } from 'react';

/** `pending` until the device answers, then `locked` or `open`. */
export type LockPhase = 'pending' | 'locked' | 'open';

/**
 * The default is `open`: a consumer mounted without the gate — a preview, or a
 * case that renders one component — is not silently silenced by having no
 * answer.
 */
const AppLockPhaseContext = createContext<LockPhase>('open');

export const AppLockPhaseProvider = AppLockPhaseContext.Provider;

/** What the gate has answered about this device. */
export function useAppLockPhase(): LockPhase {
  return useContext(AppLockPhaseContext);
}
