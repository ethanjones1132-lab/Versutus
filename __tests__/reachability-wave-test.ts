import {
  PROBE_WAVE_CONCURRENCY,
  planProbeWave,
  runCapped,
  withWaveChecking,
} from '@/lib/gateway/reachability-wave';
import type { GatewayReachability } from '@/lib/gateway/dashboard';
import type { GatewayProfile } from '@/lib/gateway/types';

function gateway(id: string): GatewayProfile {
  return { id, name: id, url: `http://${id}:8642`, createdAt: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let scheduled lane coroutines run to their next await point. */
async function tick(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('PROBE_WAVE_CONCURRENCY', () => {
  test('the cap stays small enough to be phone-friendly', () => {
    expect(PROBE_WAVE_CONCURRENCY).toBeGreaterThanOrEqual(2);
    expect(PROBE_WAVE_CONCURRENCY).toBeLessThanOrEqual(4);
  });
});

describe('runCapped', () => {
  test('never runs more workers than the cap allows', async () => {
    const started: number[] = [];
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const run = runCapped([1, 2, 3, 4, 5], 2, async (item, index) => {
      started.push(index);
      return gates[index].promise;
    });

    await tick();
    // Only the first two items may start; the rest wait for a lane.
    expect(started).toEqual([0, 1]);

    gates[0].resolve('a');
    await tick();
    // The freed lane immediately claims the next queued item.
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve('b');
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2].resolve('c');
    gates[3].resolve('d');
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    gates[4].resolve('e');
    await expect(run).resolves.toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('results keep input order even when completion order is reversed', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const run = runCapped(['slow', 'mid', 'fast'], 3, async (_item, index) =>
      gates[index].promise,
    );

    gates[2].resolve('fast-done');
    gates[1].resolve('mid-done');
    gates[0].resolve('slow-done');

    await expect(run).resolves.toEqual(['slow-done', 'mid-done', 'fast-done']);
  });

  test('a cap at or above the item count starts everything at once', async () => {
    const started: string[] = [];
    const run = runCapped(['x', 'y'], 8, async (item) => {
      started.push(item);
      return item.toUpperCase();
    });

    await expect(run).resolves.toEqual(['X', 'Y']);
    expect(started.sort()).toEqual(['x', 'y']);
  });

  test('an empty roster resolves without calling the worker', async () => {
    let calls = 0;
    await expect(
      runCapped([], 3, async () => {
        calls += 1;
        return null;
      }),
    ).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  test('a hostile cap clamps to one lane instead of zero or negative pools', async () => {
    const started: number[] = [];
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const run = runCapped([1, 2, 3], 0, async (_item, index) => {
      started.push(index);
      return gates[index].promise;
    });

    await tick();
    // One lane only: exactly the first item is in flight.
    expect(started).toEqual([0]);

    gates[0].resolve('a');
    await tick();
    expect(started).toEqual([0, 1]);

    gates[1].resolve('b');
    gates[2].resolve('c');
    await expect(run).resolves.toEqual(['a', 'b', 'c']);
  });

  test('a rejecting worker rejects the whole run — no silent swallowing', async () => {
    const run = runCapped([1], 2, async () => {
      throw new Error('probe exploded');
    });
    await expect(run).rejects.toThrow('probe exploded');
  });
});

describe('withWaveChecking', () => {
  const previous: Record<string, GatewayReachability> = {
    settled: {
      gatewayId: 'settled',
      url: 'http://settled:8642',
      state: 'reachable',
      latencyMs: 42,
      checkedAt: 5_000,
    },
    errored: {
      gatewayId: 'errored',
      url: 'http://errored:8642',
      state: 'unreachable',
      checkedAt: 3_000,
      error: 'timed out',
    },
  };

  test('every due gateway flips to checking in one fold', () => {
    const due = [gateway('settled'), gateway('fresh')];
    const next = withWaveChecking(previous, due);
    expect(next.settled.state).toBe('checking');
    expect(next.fresh.state).toBe('checking');
    expect(next.fresh).toEqual({
      gatewayId: 'fresh',
      url: 'http://fresh:8642',
      state: 'checking',
      checkedAt: undefined,
      latencyMs: undefined,
      error: undefined,
    });
  });

  test("each record's own stamp, latency and error ride through unchanged", () => {
    const next = withWaveChecking(previous, [
      gateway('settled'),
      gateway('errored'),
    ]);
    expect(next.settled.checkedAt).toBe(5_000);
    expect(next.settled.latencyMs).toBe(42);
    expect(next.settled.error).toBeUndefined();
    expect(next.errored.checkedAt).toBe(3_000);
    expect(next.errored.error).toBe('timed out');
  });

  test('a gateway not in the wave is untouched and never invented', () => {
    const next = withWaveChecking(previous, [gateway('fresh')]);
    expect(next.settled).toBe(previous.settled);
    expect(Object.keys(next).sort()).toEqual(['errored', 'fresh', 'settled']);
  });

  test('an empty due list answers the same records', () => {
    expect(withWaveChecking(previous, [])).toEqual(previous);
  });
});

describe('the reachability wave in the hook', () => {
  // The optimization is the shape of the hook, not just the fold: the wave
  // marks every due gateway checking in ONE state write, and the settle
  // writes stay one-per-settle so early verdicts still paint early.
  const fs = require('fs');
  const path = require('path');
  const hookSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'hooks', 'use-gateway-reachability.ts'),
    'utf8',
  );

  test('the whole wave is marked checking by one write through the fold', () => {
    expect(hookSource).toContain('setResults((previous) => withWaveChecking(previous, due))');
    expect(hookSource).not.toContain("setReachability(gateway, 'checking')");
  });
});

describe('planProbeWave', () => {
  const minIntervalMs = 8_000;

  test('the connected-active gateway is trusted live and never probed', () => {
    const gateways = [gateway('active'), gateway('other')];
    const due = planProbeWave({
      gateways,
      activeGatewayId: 'active',
      activeConnected: true,
      lastProbeAt: {},
      now: 100_000,
      minIntervalMs,
    });
    expect(due.map((item) => item.id)).toEqual(['other']);
  });

  test('the active gateway is still probed while its connection is down', () => {
    const gateways = [gateway('active'), gateway('other')];
    const due = planProbeWave({
      gateways,
      activeGatewayId: 'active',
      activeConnected: false,
      lastProbeAt: {},
      now: 100_000,
      minIntervalMs,
    });
    expect(due.map((item) => item.id)).toEqual(['active', 'other']);
  });

  test('gateways probed inside the debounce window wait for a later wave', () => {
    const gateways = [gateway('fresh'), gateway('stale')];
    const due = planProbeWave({
      gateways,
      activeGatewayId: null,
      activeConnected: false,
      lastProbeAt: { fresh: 97_000, stale: 80_000 },
      now: 100_000,
      minIntervalMs,
    });
    expect(due.map((item) => item.id)).toEqual(['stale']);
  });

  test('a gateway whose interval elapsed exactly is due again', () => {
    const gateways = [gateway('edge')];
    const due = planProbeWave({
      gateways,
      activeGatewayId: null,
      activeConnected: false,
      lastProbeAt: { edge: 92_000 },
      now: 100_000,
      minIntervalMs,
    });
    expect(due.map((item) => item.id)).toEqual(['edge']);
  });

  test('a gateway with no ledger entry is due on its first wave', () => {
    const gateways = [gateway('newcomer')];
    const due = planProbeWave({
      gateways,
      activeGatewayId: null,
      activeConnected: false,
      lastProbeAt: {},
      now: 100_000,
      minIntervalMs,
    });
    expect(due.map((item) => item.id)).toEqual(['newcomer']);
  });

  test('due gateways keep roster order so capped lanes drain fairly', () => {
    const gateways = [gateway('c'), gateway('a'), gateway('b')];
    const due = planProbeWave({
      gateways,
      activeGatewayId: null,
      activeConnected: false,
      lastProbeAt: {},
      now: 100_000,
      minIntervalMs,
    });
    expect(due.map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });
});
