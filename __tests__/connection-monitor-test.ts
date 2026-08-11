import { ConnectionMonitor, HEALTH_INTERVAL_MS } from '@/lib/gateway/connection-monitor';
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
});
