import {
  ConnectionMonitor,
  HEALTH_INTERVAL_MS,
  hasRecentContact,
} from '@/lib/gateway/connection-monitor';
import type { ConnectionMonitorCallbacks } from '@/lib/gateway/connection-monitor';

describe('ConnectionMonitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function build(overrides: Partial<ConnectionMonitorCallbacks> = {}) {
    const state = { healthy: true, servedRecently: false, reconnects: 0 };
    const statuses: string[] = [];
    const monitor = new ConnectionMonitor({
      probe: () => Promise.resolve(state.healthy),
      recentlyServedUs: () => state.servedRecently,
      onStatus: (status) => {
        statuses.push(status);
      },
      reconnect: () => {
        state.reconnects += 1;
        return Promise.resolve();
      },
      ...overrides,
    });
    return { monitor, state, statuses };
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
