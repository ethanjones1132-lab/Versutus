import {
  GATE_RECONNECT_SAFETY_MARGIN_MS,
  GATE_RECONNECT_WINDOW_MS,
  gateReconnectDelays,
  reconnectGateMedia,
} from '@/lib/voice/gate-reconnect';
import type { GateVoiceGrant } from '@/lib/voice/handsfree-start-reason';

const grant: GateVoiceGrant = {
  voiceSessionId: 'vs-1',
  streamPath: '/v1/voice/stream',
  engine: 'local',
};

const options = { url: 'ws://gate.local:8760/v1/voice/stream', token: 'tok', voiceSessionId: 'vs-1' };

function sleeper() {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

/** A clock the injected `sleep`/`now` move, so an attempt's start time is known. */
function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

describe('gateReconnectDelays', () => {
  test('fits every backoff step inside the Gate resume window', () => {
    const delays = gateReconnectDelays();
    // Strictly inside: the last attempt has to start while the Gate is still
    // holding the call, so a schedule that sums to exactly the window has no
    // last attempt in it at all.
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(GATE_RECONNECT_WINDOW_MS);
    expect(delays.length).toBeGreaterThan(1);
    // The backoff itself never shrinks by more than half a step. The last delay
    // is not part of that shape: it is whatever is left of the window once the
    // safety margin is held back, so it is shorter than the step before it.
    for (let i = 1; i < delays.length - 1; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] / 2);
    }
    expect(delays[delays.length - 1]).toBeGreaterThan(0);
  });

  test('keeps the early backoff and lands the last shot before the window closes', () => {
    const delays = gateReconnectDelays();
    expect(delays.slice(0, 5)).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
    const last = delays[delays.length - 1];
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      GATE_RECONNECT_WINDOW_MS - GATE_RECONNECT_SAFETY_MARGIN_MS,
    );
    expect(last).toBe(2_000);
  });

  test('a window too small for the margin gets the backoff and no phantom last shot', () => {
    const delays = gateReconnectDelays(6_000);
    expect(delays).toEqual([500, 1_000, 2_000]);
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(6_000);
  });
});

describe('reconnectGateMedia', () => {
  test('reopens the media socket with the same grant and stops there', async () => {
    const { sleeps, sleep } = sleeper();
    const attempts: unknown[] = [];
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: (opts) => {
        attempts.push(opts);
        return Promise.resolve(true);
      },
      isAborted: () => false,
      sleep,
      now: () => 0,
    });
    expect(ok).toBe(true);
    expect(attempts).toEqual([options]);
    // The first attempt waits one backoff step; a success asks for nothing more.
    expect(sleeps).toEqual([sleeps[0]]);
  });

  // The Gate holds the call for its resume window and then stops. The schedule
  // used to sum to exactly that window, so the last attempt landed on the
  // deadline, was refused and the tail was dead air: a link that came back at
  // 17 s lost a call that was still held. Every attempt below starts while the
  // window is open, with room for its round trip.
  test('the last attempt is issued inside the window, not slept through', async () => {
    const time = clock();
    const attemptsAt: number[] = [];
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        attemptsAt.push(time.now());
        return Promise.resolve(false);
      },
      isAborted: () => false,
      sleep: time.sleep,
      now: time.now,
    });
    expect(ok).toBe(false);
    expect(attemptsAt.length).toBe(gateReconnectDelays().length);
    const last = attemptsAt[attemptsAt.length - 1];
    expect(last).toBeLessThanOrEqual(GATE_RECONNECT_WINDOW_MS - GATE_RECONNECT_SAFETY_MARGIN_MS);
    // No attempt is ever issued past the point of no return.
    for (const at of attemptsAt) expect(at).toBeLessThan(GATE_RECONNECT_WINDOW_MS);
  });

  test('a Gate that only accepts the last attempt is still rejoined', async () => {
    const time = clock();
    let calls = 0;
    const total = gateReconnectDelays().length;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        return Promise.resolve(calls === total);
      },
      isAborted: () => false,
      sleep: time.sleep,
      now: time.now,
    });
    expect(calls).toBe(total);
    expect(ok).toBe(true);
  });

  test('the delays sum to less than the window it is fitted into', () => {
    for (const windowMs of [GATE_RECONNECT_WINDOW_MS, 12_000, 20_000, 45_000]) {
      const delays = gateReconnectDelays(windowMs);
      expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(windowMs);
    }
  });

  test('a custom window still fits, and its last attempt is inside that window', async () => {
    const time = clock();
    const attemptsAt: number[] = [];
    await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        attemptsAt.push(time.now());
        return Promise.resolve(false);
      },
      isAborted: () => false,
      sleep: time.sleep,
      now: time.now,
      windowMs: 12_000,
    });
    expect(attemptsAt.length).toBeGreaterThan(0);
    const last = attemptsAt[attemptsAt.length - 1];
    expect(last).toBeLessThanOrEqual(12_000 - GATE_RECONNECT_SAFETY_MARGIN_MS);
  });

  test('teardown still wins before every attempt, mid-schedule', async () => {
    const time = clock();
    let calls = 0;
    let aborted = false;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        if (calls === 2) aborted = true;
        return Promise.resolve(false);
      },
      isAborted: () => aborted,
      sleep: time.sleep,
      now: time.now,
    });
    expect(ok).toBe(false);
    expect(calls).toBe(2);
  });

  test('retries through refusal until the socket opens', async () => {
    const { sleeps, sleep } = sleeper();
    let calls = 0;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        return Promise.resolve(calls >= 3);
      },
      isAborted: () => false,
      sleep,
      now: () => 0,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps.length).toBe(3);
  });

  test('gives up when the call ended while reconnecting', async () => {
    const { sleep } = sleeper();
    let calls = 0;
    let aborted = false;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        return Promise.resolve(false);
      },
      isAborted: () => aborted,
      sleep: async (ms) => {
        await sleep(ms);
        aborted = true;
      },
      now: () => 0,
    });
    expect(ok).toBe(false);
    expect(calls).toBe(0);
  });

  test('gives up when the window runs out without a socket', async () => {
    const { sleep } = sleeper();
    let clock = 0;
    let calls = 0;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        clock += 30_000;
        return Promise.resolve(false);
      },
      isAborted: () => false,
      sleep: async (ms) => {
        await sleep(ms);
        clock += ms;
      },
      now: () => clock,
    });
    expect(ok).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  test('a throwing startGateMedia is an attempt, not a rejection', async () => {
    const { sleep } = sleeper();
    let calls = 0;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(true);
      },
      isAborted: () => false,
      sleep,
      now: () => 0,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(2);
  });
});
