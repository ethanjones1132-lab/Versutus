/**
 * Auto-retry cool-down ladder for the gateway-provider connect loop.
 *
 * A gateway that is down must not be re-probed on a flat interval forever:
 * every consecutive failed attempt doubles the wait, capped at five minutes,
 * so an offline gateway settles into a gentle ~5-minute heartbeat while a
 * flapping one still recovers within seconds. Pure and node-testable — the
 * provider owns timers and refs; this module only answers "how long next".
 */

export const AUTO_RETRY_BASE_DELAY_MS = 12_000;
export const AUTO_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

/**
 * Cool-down before the NEXT automatic attempt after `consecutiveFailures`
 * straight failures (0 = the first schedule). `floorMs` lets a call site keep
 * its deliberate first-attempt pacing (e.g. 30s when there are no candidates
 * to probe at all); the answer never waits LESS than that floor and never
 * MORE than the cap.
 */
export function autoRetryDelayMs(
  consecutiveFailures: number,
  floorMs: number = AUTO_RETRY_BASE_DELAY_MS,
): number {
  const effectiveFloorMs = Number.isFinite(floorMs) ? floorMs : AUTO_RETRY_BASE_DELAY_MS;
  const effectiveConsecutiveFailures = Number.isFinite(consecutiveFailures) ? consecutiveFailures : 0;
  const rung = Math.min(
    AUTO_RETRY_MAX_DELAY_MS,
    AUTO_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, Math.floor(effectiveConsecutiveFailures)),
  );
  return Math.min(AUTO_RETRY_MAX_DELAY_MS, Math.max(rung, effectiveFloorMs));
}

/** What the UI needs to know about ONE pending automatic retry. */
export type AutoRetryPulse = {
  /** Human ordinal of the upcoming attempt (1 = the first retry). */
  attempt: number;
  /** Cool-down that must elapse before that attempt fires. */
  delayMs: number;
  /** True once the ladder has settled on its five-minute cadence. */
  capped: boolean;
};

/**
 * Computed whenever the provider schedules an automatic retry so the UI can
 * show what is WAITING instead of a bare "disconnected" - without it a capped
 * ladder looks identical to a dead app while it quietly keeps trying every
 * five minutes.
 */
export function autoRetryPulse(
  consecutiveFailures: number,
  floorMs: number = AUTO_RETRY_BASE_DELAY_MS,
): AutoRetryPulse {
  const delayMs = autoRetryDelayMs(consecutiveFailures, floorMs);
  return {
    attempt: Math.max(0, Math.floor(consecutiveFailures)) + 1,
    delayMs,
    capped: delayMs >= AUTO_RETRY_MAX_DELAY_MS,
  };
}

/**
 * One honest line about the pending retry: short waits name the exact
 * next-try delay, a capped ladder admits it has stopped accelerating.
 */
export function describeAutoRetry(pulse: AutoRetryPulse): string {
  if (pulse.capped) {
    return 'Gateway unreachable - Versutus keeps trying automatically every five minutes.';
  }
  return `Reconnecting automatically - next try in ${Math.max(1, Math.round(pulse.delayMs / 1000))}s.`;
}
