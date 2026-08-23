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
  const rung = Math.min(
    AUTO_RETRY_MAX_DELAY_MS,
    AUTO_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, Math.floor(consecutiveFailures)),
  );
  return Math.min(AUTO_RETRY_MAX_DELAY_MS, Math.max(rung, floorMs));
}
