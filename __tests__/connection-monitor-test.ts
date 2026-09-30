import {
  ConnectionMonitor,
  HEALTH_INTERVAL_MS,
  NUDGE_COOLDOWN_MS,
  NUDGE_REPROBE_DELAY_MS,
  RECONNECT_ESCALATION_ATTEMPTS,
  hasRecentContact,
} from '@/lib/gateway/connection-monitor';
import type { ConnectionMonitorCallbacks } from '@/lib/gateway/connection-monitor';

describe('ConnectionMonitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function build(overrides: Partial<ConnectionMonitorCallbacks> = {}) {
    const state = { healthy: true, servedRecently: false, reconnects: 0 };
    const statuses: string[] = [];
    const details: string[] = [];
    const monitor = new ConnectionMonitor({
      probe: () => Promise.resolve(state.healthy),
      recentlyServedUs: () => state.servedRecently,
      onStatus: (status, detail) => {
        statuses.push(status);
        if (detail) details.push(detail);
      },
      reconnect: () => {
        state.reconnects += 1;
        return Promise.resolve();
      },
      ...overrides,
    });
    return { monitor, state, statuses, details };
  }

  test('one failed probe does not declare the gateway down', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();

    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);

    expect(statuses).not.toContain('reconnecting');
    monitor.stop();
  });

  test('two consecutive failures declare the gateway down', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();

    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);

    expect(statuses).toContain('reconnecting');
    monitor.stop();
  });

  test('a gateway still serving other requests is never declared down', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();

    state.healthy = false;
    state.servedRecently = true;
    for (let i = 0; i < 4; i += 1) {
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    }

    expect(statuses).not.toContain('reconnecting');
    monitor.stop();
  });

  test('recovery cancels a queued reconnect', async () => {
    const { monitor, state } = build();
    monitor.start();

    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);

    state.healthy = true;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    const afterRecovery = state.reconnects;

    await jest.advanceTimersByTimeAsync(120_000);
    expect(state.reconnects).toBe(afterRecovery);
    monitor.stop();
  });

  test('suspend stops probing until resumed', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();
    monitor.suspend();

    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 4);
    expect(statuses).not.toContain('reconnecting');

    monitor.stop();
  });

  test(
    'a completed response forgives an earlier failure, and only a fresh run ' +
      'of silent failures declares the gateway down',
    async () => {
      // Pins the DECIDED masking semantics end-to-end through the same
      // predicate the clients wire in: recent contact excuses the probe AND
      // forgives the streak; once responses stop, detection still happens
      // within HEALTH_FAILURE_THRESHOLD unevidenced probes of the last
      // answer — an old count must not leak across a busy period.
      const state = { healthy: true, contactAt: 0, reconnects: 0 };
      const statuses: string[] = [];
      const monitor = new ConnectionMonitor({
        probe: () => Promise.resolve(state.healthy),
        recentlyServedUs: () => hasRecentContact(state.contactAt, Date.now()),
        onStatus: (status) => statuses.push(status),
        reconnect: () => {
          state.reconnects += 1;
          return Promise.resolve();
        },
      });
      monitor.start();

      state.healthy = false;
      // Tick 1 (t=30s): no response ever arrived — the failure counts.
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
      expect(statuses).not.toContain('reconnecting');

      // A chat response lands at t=50s.
      await jest.advanceTimersByTimeAsync(20_000);
      state.contactAt = Date.now();

      // Tick 2 (t=60s): /health still fails, but the gateway answered 10s
      // ago. The probe is excused and the earlier failure is forgiven.
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
      expect(statuses).not.toContain('reconnecting');

      // Traffic stops. Tick 3 (t=90s): stale now, so this failure counts —
      // as failure ONE. Before streak forgiveness this tick declared the
      // gateway down by leaking tick-1's count across the busy period.
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
      expect(statuses).not.toContain('reconnecting');

      // Tick 4 (t=120s): second consecutive unevidenced failure.
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
      expect(statuses).toContain('reconnecting');

      monitor.stop();
    },
  );
});

describe('ConnectionMonitor retry ladder', () => {
  // Pinned so every rung's delay is exactly its base (jitter factor 1.0) —
  // the timing assertions below read deterministically.
  let randomSpy: jest.SpyInstance<number>;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    randomSpy.mockRestore();
    jest.useRealTimers();
  });

  function countingMonitor() {
    const statuses: string[] = [];
    const details: string[] = [];
    let reconnects = 0;
    const monitor = new ConnectionMonitor({
      onStatus: (status, detail) => {
        statuses.push(status);
        if (detail) details.push(detail);
      },
      reconnect: () => {
        reconnects += 1;
        return Promise.resolve();
      },
    });
    return { monitor, statuses, details, reconnects: () => reconnects };
  }

  test('a scheduler-only monitor never probes but still schedules retries', async () => {
    const { monitor, statuses, reconnects } = countingMonitor();
    monitor.start();

    // No probe wired → no interval work, no phantom statuses.
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);
    expect(statuses).toEqual([]);
    expect(reconnects()).toBe(0);

    monitor.scheduleReconnect('socket lost');
    expect(statuses).toContain('reconnecting');
    await jest.advanceTimersByTimeAsync(999);
    expect(reconnects()).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconnects()).toBe(1); // fired exactly at the 1000ms base
    monitor.stop();
  });

  test('retry delays carry jitter so a fleet does not retry in lockstep', () => {
    // Fresh monitor per extreme so both rungs sit on the same 1000ms base.
    randomSpy.mockReturnValue(0); // jitter factor 0.75 → 750ms
    const low = countingMonitor();
    low.monitor.scheduleReconnect('gateway gone');
    jest.advanceTimersByTime(749);
    expect(low.reconnects()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(low.reconnects()).toBe(1);

    randomSpy.mockReturnValue(0.99); // jitter factor 1.245 → 1245ms
    const high = countingMonitor();
    high.monitor.scheduleReconnect('gateway gone');
    jest.advanceTimersByTime(1244);
    expect(high.reconnects()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(high.reconnects()).toBe(1);
  });

  test('sustained failure escalates to an honest disconnect instead of retrying forever', () => {
    const { monitor, statuses, details, reconnects } = countingMonitor();

    for (let rung = 0; rung < RECONNECT_ESCALATION_ATTEMPTS; rung += 1) {
      monitor.scheduleReconnect('gateway gone');
      jest.advanceTimersByTime(60_000); // each rung fires its retry
    }
    expect(reconnects()).toBe(RECONNECT_ESCALATION_ATTEMPTS);

    // One failure too many: stop the ladder, report honestly.
    monitor.scheduleReconnect('gateway gone');
    expect(statuses[statuses.length - 1]).toBe('disconnected');
    expect(details[details.length - 1]).toMatch(/paused after 5 failed retries/);

    jest.advanceTimersByTime(600_000);
    expect(reconnects()).toBe(RECONNECT_ESCALATION_ATTEMPTS); // stopped, not slowed

    // Whatever fires next starts a fresh ladder instead of inheriting the burn.
    monitor.scheduleReconnect('gateway gone');
    jest.advanceTimersByTime(999);
    expect(reconnects()).toBe(RECONNECT_ESCALATION_ATTEMPTS);
    jest.advanceTimersByTime(1);
    expect(reconnects()).toBe(RECONNECT_ESCALATION_ATTEMPTS + 1); // base 1000ms again
  });

  test('escalation does not block a later recovery through the probe', async () => {
    const state = { healthy: false };
    const statuses: string[] = [];
    let reconnects = 0;
    const monitor = new ConnectionMonitor({
      probe: () => Promise.resolve(state.healthy),
      onStatus: (status) => statuses.push(status),
      reconnect: () => {
        reconnects += 1;
        return Promise.resolve();
      },
    });
    monitor.start();

    // Burn two full waves into escalation without ever recovering.
    state.healthy = false;
    for (let wave = 0; wave < 2; wave += 1) {
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2); // declare down
      for (let rung = 0; rung < RECONNECT_ESCALATION_ATTEMPTS; rung += 1) {
        monitor.scheduleReconnect('gateway became unreachable');
        await jest.advanceTimersByTimeAsync(60_000);
      }
      monitor.scheduleReconnect('gateway became unreachable'); // escalates this wave
    }
    expect(statuses).toContain('disconnected');

    // The gateway returns: the next successful probe self-heals to connected.
    state.healthy = true;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(statuses[statuses.length - 1]).toBe('connected');

    // And the healed connection schedules from scratch afterwards.
    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2);
    expect(statuses.filter((s) => s === 'reconnecting').length).toBeGreaterThan(0);
    monitor.stop();
  });
});

describe('ConnectionMonitor nudge', () => {
  // A dead path is otherwise only visible after two failed 30s samples —
  // 42-72s. nudge() is the escape hatch: a caller holding evidence of trouble
  // asks for a verdict now.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function build(overrides: Partial<ConnectionMonitorCallbacks> = {}) {
    const state = { healthy: true, servedRecently: false, probes: 0, reconnects: 0 };
    const statuses: string[] = [];
    const monitor = new ConnectionMonitor({
      probe: () => {
        state.probes += 1;
        return Promise.resolve(state.healthy);
      },
      recentlyServedUs: () => state.servedRecently,
      onStatus: (status) => statuses.push(status),
      reconnect: () => {
        state.reconnects += 1;
        return Promise.resolve();
      },
      ...overrides,
    });
    return { monitor, state, statuses };
  }

  test('a healthy gateway probed on demand changes nothing', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();
    const before = state.probes;

    monitor.nudge('stream stalled');
    await jest.advanceTimersByTimeAsync(NUDGE_REPROBE_DELAY_MS * 2);

    // A success is not news: no status moved and no follow-up probe was
    // scheduled, so a healthy connection is never disturbed by a nudge.
    expect(state.probes).toBe(before + 1);
    expect(statuses).toEqual([]);
    monitor.stop();
  });

  test('two quick failures declare the gateway down in ~2s, not 72s', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();
    state.healthy = false;

    monitor.nudge('stream stalled');
    await jest.advanceTimersByTimeAsync(NUDGE_REPROBE_DELAY_MS - 1);
    // Failure ONE is not a verdict — one lost sample must not tear down a
    // working session — so nothing has moved a second before the re-probe.
    expect(statuses).not.toContain('reconnecting');

    await jest.advanceTimersByTimeAsync(1); // the 2s re-prove fires
    expect(statuses).toContain('reconnecting');

    // The 30s interval alone would not have fired a second sample yet: this is
    // the whole point of the nudge.
    expect(state.probes).toBe(2);
    // Having declared the path down, the nudge hands recovery to the same
    // ladder the interval uses — it does not invent a second policy.
    expect(state.reconnects).toBe(0);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(state.reconnects).toBe(1);
    monitor.stop();
  });

  test('two nudges inside the cooldown probe once', async () => {
    // A healthy gateway, so the only thing that could add a second probe is
    // the second nudge: the re-probe is reserved for an unproven failure.
    const { monitor, state } = build();
    monitor.start();

    monitor.nudge('stream stalled');
    await jest.advanceTimersByTimeAsync(1);
    expect(state.probes).toBe(1);

    monitor.nudge('stream stalled again');
    await jest.advanceTimersByTimeAsync(NUDGE_COOLDOWN_MS - 1);
    expect(state.probes).toBe(1); // still inside the 5s window

    monitor.nudge('and again');
    await jest.advanceTimersByTimeAsync(1);
    expect(state.probes).toBe(2); // the window has passed: answered again
    monitor.stop();
  });

  test('a nudge while suspended is a no-op', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();
    monitor.suspend();
    state.healthy = false;

    monitor.nudge('stream stalled');
    await jest.advanceTimersByTimeAsync(NUDGE_COOLDOWN_MS * 2);

    expect(state.probes).toBe(0);
    expect(statuses).not.toContain('reconnecting');
    monitor.stop();
  });

  test('a nudge never starts an interval on a monitor nobody started', async () => {
    const { monitor, state, statuses } = build();
    state.healthy = false;

    monitor.nudge('stream stalled');
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2);

    // The app never connected this client: a nudge must not turn a dormant
    // monitor into a poller against a gateway it was never pointed at.
    expect(state.probes).toBe(0);
    expect(statuses).toEqual([]);
    monitor.stop();
  });

  test('a scheduler-only monitor with no probe cannot be nudged', async () => {
    const statuses: string[] = [];
    const monitor = new ConnectionMonitor({
      onStatus: (status) => statuses.push(status),
      reconnect: () => Promise.resolve(),
    });
    monitor.start();

    monitor.nudge('stream stalled');
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2);

    expect(statuses).toEqual([]);
    monitor.stop();
  });

  test('a gateway that still answered us is excused exactly as the interval excuses it', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();
    state.healthy = false;
    state.servedRecently = true;

    monitor.nudge('stream stalled');
    await jest.advanceTimersByTimeAsync(NUDGE_REPROBE_DELAY_MS * 3);

    expect(statuses).not.toContain('reconnecting');
    monitor.stop();
  });
});

describe('hasRecentContact', () => {
  const ANSWERED_AT = 1_000_000;

  test('an answer inside one probe interval counts as recent', () => {
    expect(hasRecentContact(ANSWERED_AT, ANSWERED_AT + HEALTH_INTERVAL_MS - 1)).toBe(true);
  });

  test('an answer exactly one probe interval old is already stale', () => {
    expect(hasRecentContact(ANSWERED_AT, ANSWERED_AT + HEALTH_INTERVAL_MS)).toBe(false);
  });

  test('a gateway we have never heard from is never recent', () => {
    expect(hasRecentContact(0, ANSWERED_AT)).toBe(false);
  });
});
