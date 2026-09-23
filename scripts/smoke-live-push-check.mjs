// Classification for smoke:live's `notifications.test` dispatch — Solution
// A5's verify step (FUTURE-ITEMS.md Solution A; plan 2026-09-11 G6).
//
// The dispatch itself lives in smoke-live-gateway.mts; these two pure helpers
// are what its printed line is built from, so they sit in a plain .mjs the
// node --test leg (scripts/__tests__) can import directly:
//
// - `advertisesTestPush` reads the gateway's own `rpcMethods` table (the Gate
//   publishes it on the manifest, Hermes reports none) — advertisement is a
//   fact, never an inference from the gateway's kind.
// - `classifyTestPushResult` is the three-way split the plan pins: a
//   structured `{ skipped: 'no-token' }` skips cleanly (an operator laptop
//   with no phone registered under this harness id must not fail the suite),
//   a ticketed Expo send passes, and a failed or unrecognised answer fails
//   (a broken relay must never read as green).

/** The Gate RPC that sends one contentless test push to the calling device. */
export const TEST_PUSH_METHOD = 'notifications.test';

/**
 * Whether the connected gateway advertises the test-push dispatch at all.
 * Only a Gate's manifest carries `rpcMethods`; a missing or malformed table
 * means "unknown" and reads as not-advertised, never as a green dispatch.
 */
export function advertisesTestPush(snapshot) {
  const methods = snapshot?.rpcMethods;
  return Array.isArray(methods) && methods.includes(TEST_PUSH_METHOD);
}

/**
 * Turn one `notifications.test` result into the smoke verdict.
 *
 * Returns `{ status: 'pass' | 'skip' | 'fail', detail }` — `detail` always
 * carries enough to print the line without re-inspecting the payload.
 */
export function classifyTestPushResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { status: 'fail', detail: 'malformed response' };
  }

  // The Gate's own structured skip (push-rpc.mjs): the calling device has no
  // registered Expo token. Honest, expected on a host with no phone — skip.
  if (typeof result.skipped === 'string' && result.skipped.length > 0) {
    if (result.skipped === 'no-token') {
      return {
        status: 'skip',
        detail: 'no registered device token for this caller (expected without a paired phone)',
      };
    }
    return { status: 'skip', detail: `skipped: ${result.skipped}` };
  }

  // push-send.mjs answers errors as `{ ok: false, error }` rather than
  // throwing — an Expo failure must surface as a FAIL, not fall through.
  if (result.ok === false) {
    const detail =
      typeof result.error === 'string' && result.error.length > 0 ? result.error : 'send failed';
    return { status: 'fail', detail };
  }

  // One message in, one ticket out (push-send normalises per message); a
  // ticketed `ok: true` is the relay doing its job end to end.
  const tickets = Array.isArray(result.tickets) ? result.tickets : [];
  if (result.ok === true && tickets.length > 0) {
    return { status: 'pass', detail: `sent ${tickets.length} ticket(s)` };
  }

  return { status: 'fail', detail: 'unrecognised response' };
}
