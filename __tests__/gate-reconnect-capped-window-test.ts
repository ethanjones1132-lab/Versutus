// ─── A long resume window keeps a capped retry cadence ─────────────────────
// The schedule used to append one sleep for everything the early backoff left
// of the window: `windowMs - 2500 - 15500`. With the Gate advertising its real
// 90 s window that was a 72 s sleep, so a link that came back at 30 s lay
// silent until the 87.5 s last shot — the backoff was capped, the sleep was
// not. The window is now fed through the widest backoff step, so the whole
// advertised window is spent retrying at the backoff's cadence and no single
// wait grows past it, however long the Gate says it holds the call.
//
// These drive the loop against a fake clock, so they run the schedule the way
// a real call would: attempts land where the sleeps put them, teardown wins,
// and no attempt is issued after the deadline.

import {
  GATE_RECONNECT_MAX_STEP_MS,
  GATE_RECONNECT_SAFETY_MARGIN_MS,
  gateReconnectDelays,
  reconnectGateMedia,
} from '@/lib/voice/gate-reconnect';
import type { GateVoiceGrant } from '@/lib/voice/handsfree-start-reason';

const grant: GateVoiceGrant = {
  voiceSessionId: 'vs-1',
  streamPath: '/v1/voice/stream',
  engine: 'local',
};

/** The resume window a current Gate advertises in a `ready` frame. */
const GATE_WINDOW_MS = 90_000;

/** A clock the injected `sleep`/`now` move, and an attempt may slow. */
function fakeClock() {
  let at = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => at,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      at += ms;
    },
    // What an attempt costs in real time: its round trip. Called from inside
    // `startGateMedia` before it answers.
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe('gateReconnectDelays with a 90 s window', () => {
  test('keeps the early backoff and spends the rest of the window in capped steps', () => {
    const delays = gateReconnectDelays(GATE_WINDOW_MS);
    // The backoff steps come first, unchanged for a window of any size.
    expect(delays.slice(0, 5)).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
    // No wait is ever wider than the backoff it continues — not even the last.
    expect(Math.max(...delays)).toBeLessThanOrEqual(GATE_RECONNECT_MAX_STEP_MS);
    // The whole advertised window is spent, minus the safety margin the last
    // shot keeps, and within one capped step of it — not a budget that shrinks.
    const sum = delays.reduce((total, ms) => total + ms, 0);
    expect(sum).toBeLessThanOrEqual(GATE_WINDOW_MS - GATE_RECONNECT_SAFETY_MARGIN_MS);
    expect(sum).toBeGreaterThan(
      GATE_WINDOW_MS - GATE_RECONNECT_SAFETY_MARGIN_MS - GATE_RECONNECT_MAX_STEP_MS,
    );
  });
});

describe('reconnectGateMedia across a 90 s window', () => {
  test('a link restored at 30 s is retried within one capped step of coming back', async () => {
    const time = fakeClock();
    const attemptsAt: number[] = [];
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        attemptsAt.push(time.now());
        // In the field the take-back is not instant: the Gate re-attaches
        // roughly 30 s into the window, and the loop is asleep when it does.
        return Promise.resolve(time.now() >= 30_000);
      },
      isAborted: () => false,
      sleep: time.sleep,
      now: time.now,
      windowMs: GATE_WINDOW_MS,
    });
    expect(ok).toBe(true);
    // The attempt that landed it is the first one at or after the restore, and
    // it is within one cap of it — not the 87.5 s tail the long sleep produced.
    const landed = attemptsAt[attemptsAt.length - 1];
    expect(landed).toBe(31_500);
    expect(landed - 30_000).toBeLessThanOrEqual(GATE_RECONNECT_MAX_STEP_MS);
    // Everything before that kept the capped cadence too.
    expect(time.sleeps.every((ms) => ms <= GATE_RECONNECT_MAX_STEP_MS)).toBe(true);
  });

  test('teardown mid-schedule still ends it, with the attempts it had made', async () => {
    const time = fakeClock();
    const attemptsAt: number[] = [];
    let aborted = false;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        attemptsAt.push(time.now());
        if (attemptsAt.length === 3) aborted = true;
        return Promise.resolve(false);
      },
      isAborted: () => aborted,
      sleep: time.sleep,
      now: time.now,
      windowMs: GATE_WINDOW_MS,
    });
    // The loop stops before its next sleep does anything for a dead call.
    expect(ok).toBe(false);
    expect(attemptsAt.length).toBe(3);
    // The window is long; nothing about aborting waits for its tail.
    expect(time.now()).toBeLessThan(GATE_WINDOW_MS);
  });

  test('each attempt pays its round trip, and the deadline still closes the loop', async () => {
    const time = fakeClock();
    const attemptsAt: number[] = [];
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        attemptsAt.push(time.now());
        // A real attempt takes its round trip before it answers; the fake
        // clock advances that much when the attempt is under way.
        time.advance(4_000);
        return Promise.resolve(false);
      },
      isAborted: () => false,
      sleep: time.sleep,
      now: time.now,
      windowMs: GATE_WINDOW_MS,
    });
    expect(ok).toBe(false);
    // The loop did not give up early: with 4 s spent per attempt it kept the
    // capped cadence until the window no longer left room for a round trip.
    expect(attemptsAt.length).toBe(9);
    expect(attemptsAt[attemptsAt.length - 1]).toBeGreaterThan(40_000);
    // And no attempt was issued at or after the deadline: each one started
    // while the Gate was still holding the call, with room to be answered.
    for (const at of attemptsAt) {
      expect(at).toBeLessThan(GATE_WINDOW_MS - 1_000);
    }
  });
});
