// ─── The audio link is proven, not assumed ─────────────────────────────────
// `startGateMedia` posts to the main queue, calls `media.start(...)` and
// resolves `true` unconditionally; OkHttp's `newWebSocket` is asynchronous, so
// every real failure arrives LATER as a `socket_failed`/`socket_closed` frame.
// Both consumers read that boolean as "the Gate is on the other end":
// `openGateVoiceSession` skipped its own `media-start-failed` branch, and
// `reconnectGateMedia` returned `true` on the first attempt and slept out the
// rest of its window. The banner then read "Listening" on a link nothing was
// on — nothing heard, nothing sent, no end reason, and a new AudioRecord + AEC
// + NS + AudioTrack per loop.
//
// These drive both halves against a link that either speaks or never does.

import { GATE_LINK_READY_MS, createGateLinkProbe, isGateSocketGone } from '@/lib/voice/gate-link';
import {
  GATE_RECONNECT_WINDOW_MS,
  reconnectGateMedia,
} from '@/lib/voice/gate-reconnect';
import { openGateVoiceSession } from '@/lib/voice/handsfree-start-attempt';
import type { GateVoiceGrant } from '@/lib/voice/handsfree-start-reason';

const grant: GateVoiceGrant = {
  voiceSessionId: 'vs-1',
  streamPath: '/v1/voice/stream',
  engine: 'local',
};

const target = {
  label: 'Untitled',
  voiceEngine: 'local',
  surfaceKind: 'bot' as const,
  sessionId: 's1',
  botId: 'hermes',
};

const ready = '{"t":"ready","engine":"local"}';
const socketFailed =
  '{"t":"error","code":"socket_failed","message":"Expected HTTP 101","fatal":true}';

/** A probe with no frames arriving unless a test says so. */
function quietProbe() {
  const probe = createGateLinkProbe();
  const budgets: number[] = [];
  return {
    budgets,
    proveLink: (budgetMs: number) => {
      budgets.push(budgetMs);
      return probe.prove(budgetMs);
    },
    probe,
  };
}

describe('isGateSocketGone', () => {
  test('is true for the two shapes the native side reports a dead link in', () => {
    expect(isGateSocketGone(socketFailed)).toBe(true);
    expect(
      isGateSocketGone('{"t":"error","code":"socket_closed","message":"closed","fatal":true}'),
    ).toBe(true);
  });

  test('is false for anything the Gate said with the link still up', () => {
    expect(isGateSocketGone(ready)).toBe(false);
    expect(isGateSocketGone('{"t":"phase","phase":"thinking"}')).toBe(false);
    expect(isGateSocketGone('not json')).toBe(false);
    // A non-fatal error is the Gate's news, not a dead socket.
    expect(isGateSocketGone('{"t":"error","code":"engine_error","message":"x","fatal":false}')).toBe(false);
  });
});

describe('the probe', () => {
  test('a frame on the socket is the proof; the budget is what it waits', async () => {
    jest.useFakeTimers();
    const { probe, budgets } = quietProbe();
    const proving = probe.prove(GATE_LINK_READY_MS);
    expect(budgets).toEqual([]);
    // Nothing has been said on the wire yet: the link is still `connecting`.
    probe.observe('{"t":"level","v":0.4}');
    await expect(proving).resolves.toBe('frame');
    jest.useRealTimers();
  });

  test('a socket that dies before the Gate speaks fails the proof immediately', async () => {
    const probe = createGateLinkProbe();
    const proving = probe.prove(10_000);
    probe.observe(socketFailed);
    await expect(proving).resolves.toBe('failed');
  });

  test('silence times out, and a late frame settles only the next proof', async () => {
    jest.useFakeTimers();
    const probe = createGateLinkProbe();
    const proving = probe.prove(10_000);
    jest.advanceTimersByTime(10_000);
    await expect(proving).resolves.toBe('timeout');
    // The call gave up on this link. A frame that arrives afterwards is late, and
    // the next link to be opened gets its own proof rather than inheriting it.
    probe.observe(ready);
    const next = probe.prove(10_000);
    probe.observe(ready);
    await expect(next).resolves.toBe('frame');
    expect(await proving).toBe('timeout');
    jest.useRealTimers();
  });

  test('a released proof settles nothing, so an abandoned start cannot be revived', async () => {
    jest.useFakeTimers();
    const probe = createGateLinkProbe();
    let settled = false;
    void probe.prove(10_000).then(() => {
      settled = true;
    });
    probe.release();
    jest.advanceTimersByTime(60_000);
    probe.observe(ready);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.useRealTimers();
  });
});

describe('openGateVoiceSession waits for the Gate to speak', () => {
  const common = {
    gatewayUrl: 'http://127.0.0.1:8760',
    gatewayToken: 'tok',
    target,
    device: { deviceId: 'phone-abc12345' },
    startSession: async () => 'started' as const,
    startId: 'hs-link',
  };

  test('a link that never sends a frame is a media start failure, not a call', async () => {
    jest.useFakeTimers();
    const { proveLink, budgets } = quietProbe();
    const calls: string[] = [];
    const canceled: string[] = [];
    const attempt = openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => {
        calls.push(method);
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      cancelStartSession: (startId) => {
        canceled.push(startId);
      },
      // The native side answers `true`: the socket was handed over. Nothing has
      // proved the Gate is on it.
      startGateMedia: async () => true,
      proveLink,
      linkReadyMs: 10_000,
      log: () => undefined,
    });

    await jest.advanceTimersByTimeAsync(10_000);
    const settled = await attempt;
    jest.useRealTimers();

    expect(settled.result).toBe('media-start-failed');
    expect(settled.detail).toMatch(/never spoke/);
    // The grant is released and the native attempt cancelled by its own id, so
    // the retry this failure invites is neither a live microphone nor
    // `call_in_progress`.
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
    expect(canceled).toEqual(['hs-link']);
    expect(budgets).toEqual([10_000]);
  });

  test('the first Gate frame on the socket is what starts the call', async () => {
    const probe = createGateLinkProbe();
    const attempt = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startGateMedia: async () => true,
      proveLink: (budgetMs) => {
        // The Gate answers its attach the way it does in the field: `ready`
        // first, then the phase it is actually in.
        const proving = probe.prove(budgetMs);
        probe.observe(ready);
        return proving;
      },
      log: () => undefined,
    });
    expect(attempt.result).toBe('started');
    expect(attempt.grant).toEqual(grant);
  });

  test('a socket that dies before any frame is the same failed attempt', async () => {
    const probe = createGateLinkProbe();
    const calls: string[] = [];
    const attempt = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => {
        calls.push(method);
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startGateMedia: async () => true,
      proveLink: (budgetMs) => {
        const proving = probe.prove(budgetMs);
        probe.observe(socketFailed);
        return proving;
      },
      log: () => undefined,
    });
    expect(attempt.result).toBe('media-start-failed');
    expect(attempt.detail).toMatch(/before the PC spoke/);
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
  });

  test('a refused socket is not waited on: there is nothing to prove', async () => {
    const { budgets } = quietProbe();
    const attempt = await openGateVoiceSession({
      ...common,
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startGateMedia: async () => false,
      proveLink: (budgetMs) => {
        budgets.push(budgetMs);
        return Promise.resolve('frame' as const);
      },
      log: () => undefined,
    });
    expect(attempt.result).toBe('media-start-failed');
    expect(attempt.detail).toBeUndefined();
    expect(budgets).toEqual([]);
  });
});

describe('reconnectGateMedia counts only a proven re-attach', () => {
  const time = () => {
    let at = 0;
    return {
      now: () => at,
      sleep: async (ms: number) => {
        at += ms;
      },
    };
  };

  /**
   * What the Gate says on each socket this loop opens. A socket the Gate never
   * attaches to times out its proof; the real probe's timers are exercised by
   * its own tests, so this stands in for the wire and keeps the loop's own
   * bookkeeping (attempts, backoff, the window) under test.
   */
  const gateSays = (spoken: boolean[]) => {
    const budgets: number[] = [];
    let attempt = 0;
    const proveLink = async (budgetMs: number) => {
      budgets.push(budgetMs);
      const spoke = spoken[attempt] ?? false;
      attempt += 1;
      return spoke ? ('frame' as const) : ('timeout' as const);
    };
    return { proveLink, budgets, attempts: () => attempt };
  };

  test('a socket that opens and never speaks is not a re-attach', async () => {
    const clock = time();
    const gate = gateSays([]);
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => Promise.resolve(true),
      proveLink: gate.proveLink,
      linkReadyMs: 2_000,
      isAborted: () => false,
      sleep: clock.sleep,
      now: clock.now,
    });
    // Every attempt answered `true` and none of them was the Gate: the window
    // ran out instead of the first answer ending the recovery.
    expect(ok).toBe(false);
    expect(gate.attempts()).toBeGreaterThan(1);
    expect(clock.now()).toBeLessThan(GATE_RECONNECT_WINDOW_MS);
  });

  test('the backoff still spreads the attempts, and a proved one ends it', async () => {
    const clock = time();
    const gate = gateSays([false, false, true]);
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => Promise.resolve(true),
      proveLink: gate.proveLink,
      linkReadyMs: 2_000,
      isAborted: () => false,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(ok).toBe(true);
    expect(gate.attempts()).toBe(3);
    // Two silent sockets cost two backoff steps before the third is issued.
    expect(clock.now()).toBe(500 + 1_000 + 2_000);
  });

  test('the window is an option, so a longer resume window is spent in full', async () => {
    const clock = time();
    const gate = gateSays([]);
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => Promise.resolve(true),
      proveLink: gate.proveLink,
      linkReadyMs: 2_000,
      windowMs: 45_000,
      isAborted: () => false,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(ok).toBe(false);
    // The default window is the Gate's own 20 s resume window; a caller that
    // knows the Gate holds longer gets to spend it, so more sockets are tried.
    expect(gate.attempts()).toBeGreaterThan(2);
  });

  test('the proof is shortened to what is left of the window, never past it', async () => {
    const clock = time();
    const gate = gateSays([]);
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => Promise.resolve(true),
      proveLink: gate.proveLink,
      linkReadyMs: 10_000,
      isAborted: () => false,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(ok).toBe(false);
    expect(gate.attempts()).toBeGreaterThan(0);
    // Every proof fits inside what was left of the window, so no attempt waits
    // past the point where the Gate has stopped holding the call.
    for (const budget of gate.budgets) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(10_000);
    }
  });

  test('a refused socket and a throwing one are attempts, not rejections', async () => {
    const clock = time();
    const gate = gateSays([false, true]);
    let calls = 0;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        // The first socket never opened, the second opened with nobody on it,
        // and the third is the Gate.
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(true);
      },
      proveLink: gate.proveLink,
      isAborted: () => false,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    // Two sockets were handed over, so two proofs ran.
    expect(gate.attempts()).toBe(2);
  });

  test('teardown still wins over a proof that would have said frame', async () => {
    const clock = time();
    const gate = gateSays([]);
    let calls = 0;
    const ok = await reconnectGateMedia({
      grant,
      gatewayUrl: 'http://gate.local:8760',
      gatewayToken: 'tok',
      startGateMedia: () => {
        calls += 1;
        return Promise.resolve(true);
      },
      proveLink: gate.proveLink,
      isAborted: () => {
        // The operator ends the call from the notification while the first
        // attempt is in flight.
        return calls >= 1;
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(ok).toBe(false);
    expect(calls).toBe(1);
  });
});