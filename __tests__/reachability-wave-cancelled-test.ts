import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useGatewayReachability } from '@/hooks/use-gateway-reachability';
import type { GatewayReachability } from '@/lib/gateway/dashboard';
import {
  planProbeWave,
  reachabilityFromProbe,
  startProbeWave,
  withWaveChecking,
  withoutWaveChecking,
  type ProbeLedger,
  type ProbeWavePlan,
} from '@/lib/gateway/reachability-wave';
import type { ProbeResult } from '@/lib/gateway/probe';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

declare const __dirname: string;

/** Mirrors the hook: 6s probe deadline, 8s debounce, and a 5s stuck margin. */
const PROBE_TIMEOUT_MS = 6000;
const MIN_PROBE_INTERVAL_MS = 8000;
const PROBE_STUCK_AFTER_MS = PROBE_TIMEOUT_MS + 5000;

/**
 * The clock every test starts from. The planner reads an unstamped gateway as
 * "probed at the epoch", so the windows above only mean anything against a
 * realistic `Date.now()`.
 */
const T0 = 1_700_000_000_000;

function gateway(id: string): GatewayProfile {
  return { id, name: id, url: `http://${id}:8642`, createdAt: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function ok(url: string, latencyMs = 42): ProbeResult {
  return { ok: true, url, latencyMs };
}

function refused(url: string, error = 'timed out'): ProbeResult {
  return { ok: false, url, error };
}

/** Let scheduled lane coroutines run to their next await point. */
async function tick(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/**
 * The wave's whole lifecycle, wired the way `useGatewayReachability` wires it:
 * the ledgers are one long-lived object (a ref in the hook), the records are
 * folded through the same pure helpers the hook folds them through, and each
 * `startWave` is one run of the effect — including its own `cancelled` flag,
 * which is what lets a replacement run probe what the run it replaced could
 * not finish.
 */
function waveHarness(gateways: GatewayProfile[]) {
  const ledger: ProbeLedger = { lastProbeAt: {}, checkingSince: {} };
  const records: Record<string, GatewayReachability> = {};
  const probes: string[] = [];
  // Every probe call opens its own gate, so a re-probe of the same url is a
  // probe that is still waiting rather than the previous one re-answered.
  const mockPending: { url: string; resolve: (result: ProbeResult) => void }[] = [];

  function startWave(overrides: Partial<ProbeWavePlan> = {}) {
    let cancelled = false;
    const plan: ProbeWavePlan = {
      gateways,
      activeGatewayId: null,
      activeConnected: false,
      lastProbeAt: ledger.lastProbeAt,
      checkingSince: ledger.checkingSince,
      now: T0,
      minIntervalMs: MIN_PROBE_INTERVAL_MS,
      stuckAfterMs: PROBE_STUCK_AFTER_MS,
      ...overrides,
    };
    const wave = startProbeWave({
      plan,
      ledger,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      isCancelled: () => cancelled,
      probe: (url) => {
        probes.push(url);
        const gate = deferred<ProbeResult>();
        mockPending.push({ url, resolve: gate.resolve });
        return gate.promise;
      },
      onChecking: (due) => Object.assign(records, withWaveChecking(records, due)),
      onVerdict: (target, result) =>
        Object.assign(records, {
          ...records,
          [target.id]: reachabilityFromProbe(target, result),
        }),
      onReleased: (stranded) => Object.assign(records, withoutWaveChecking(records, stranded)),
    });
    // What the effect's cleanup does, in the order it does it.
    const teardown = () => {
      cancelled = true;
      wave.release();
    };
    return { wave, plan, teardown };
  }

  /** Answer the most recent probe of `url`, waiting for it to be issued. */
  async function answer(url: string, result: ProbeResult) {
    await tick();
    const gate = [...mockPending].reverse().find((entry) => entry.url === url);
    if (!gate) throw new Error(`no probe was issued for ${url}`);
    gate.resolve(result);
  }

  return { ledger, records, probes, startWave, answer };
}

describe('a cancelled reachability wave leaves no gateway stranded', () => {
  test('the replacement run re-probes the gateway the cancelled wave never answered for', async () => {
    const harness = waveHarness([gateway('alpha'), gateway('beta')]);
    const first = harness.startWave();
    await tick();

    // A dependency of the effect changes while both probes are in flight.
    first.teardown();

    // The replacement effect body runs immediately after that cleanup, well
    // inside the 8s debounce, with the same gateway set.
    const second = harness.startWave();
    await tick();

    expect(harness.probes).toEqual([
      'http://alpha:8642',
      'http://beta:8642',
      'http://alpha:8642',
      'http://beta:8642',
    ]);

    await harness.answer('http://alpha:8642', ok('http://alpha:8642', 40));
    await harness.answer('http://beta:8642', refused('http://beta:8642'));
    await second.wave.settled;

    // Real verdicts, not the `checking` the cancelled wave left behind.
    expect(harness.records.alpha.state).toBe('reachable');
    expect(harness.records.alpha.latencyMs).toBe(40);
    expect(harness.records.beta.state).toBe('unreachable');
    expect(harness.records.beta.error).toBe('timed out');
    expect(Object.values(harness.records).some((record) => record.state === 'checking')).toBe(false);
  });

  test('the cancelled wave\'s rows stop reading "Checking" the moment its claim comes back', () => {
    const harness = waveHarness([gateway('alpha')]);
    const first = harness.startWave();
    expect(harness.records.alpha.state).toBe('checking');

    first.teardown();

    expect(harness.records.alpha.state).toBe('unknown');
    // The debounce stamp went with the claim, so nothing is owed a wait.
    expect(harness.ledger.lastProbeAt).toEqual({});
    expect(harness.ledger.checkingSince).toEqual({});
  });

  test('a settled gateway of the cancelled wave keeps the verdict it already wrote', async () => {
    const harness = waveHarness([gateway('alpha'), gateway('beta')]);
    const first = harness.startWave();
    await tick();
    await harness.answer('http://alpha:8642', ok('http://alpha:8642', 12));
    await tick();
    expect(harness.records.alpha.state).toBe('reachable');

    first.teardown();

    // Only the unanswered gateway was given back.
    expect(harness.records.alpha.state).toBe('reachable');
    expect(harness.records.beta.state).toBe('unknown');
    expect(harness.ledger.lastProbeAt).toEqual({ alpha: T0 });
    expect(harness.ledger.checkingSince).toEqual({});
  });

  test('giving a claim back twice is a no-op', () => {
    const harness = waveHarness([gateway('alpha')]);
    const first = harness.startWave();
    first.teardown();
    first.teardown();
    expect(harness.records.alpha.state).toBe('unknown');
    expect(harness.ledger.lastProbeAt).toEqual({});
  });

  test('a probe that throws gives its claim back instead of pinning the row', async () => {
    const ledger: ProbeLedger = { lastProbeAt: {}, checkingSince: {} };
    const records: Record<string, GatewayReachability> = {};
    const boom = startProbeWave({
      plan: {
        gateways: [gateway('alpha')],
        activeGatewayId: null,
        activeConnected: false,
        lastProbeAt: ledger.lastProbeAt,
        checkingSince: ledger.checkingSince,
        now: T0,
        minIntervalMs: MIN_PROBE_INTERVAL_MS,
        stuckAfterMs: PROBE_STUCK_AFTER_MS,
      },
      ledger,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      isCancelled: () => false,
      probe: async () => {
        throw new Error('probe exploded');
      },
      onChecking: (due) => Object.assign(records, withWaveChecking(records, due)),
      onVerdict: () => {},
      onReleased: (stranded) => Object.assign(records, withoutWaveChecking(records, stranded)),
    });

    // No unhandled rejection out of the wave, and no row left reading
    // "Checking" for a probe that threw instead of answering.
    await expect(boom.settled).resolves.toBeUndefined();
    expect(records.alpha.state).toBe('unknown');
    expect(ledger.lastProbeAt).toEqual({});
  });
});

describe('a normal wave still debounces', () => {
  test('a second wave inside 8s plans nothing once every verdict is written', async () => {
    const harness = waveHarness([gateway('alpha'), gateway('beta')]);
    const first = harness.startWave();
    await harness.answer('http://alpha:8642', ok('http://alpha:8642'));
    await harness.answer('http://beta:8642', ok('http://beta:8642'));
    await first.wave.settled;

    harness.startWave({ now: T0 + MIN_PROBE_INTERVAL_MS - 1 });
    await tick();

    expect(harness.probes).toHaveLength(2);
    expect(harness.records.alpha.state).toBe('reachable');
    expect(harness.records.beta.state).toBe('reachable');
  });

  test('a second wave inside 8s leaves the wave that is still draining alone', async () => {
    const harness = waveHarness([gateway('alpha'), gateway('beta')]);
    harness.startWave();
    await harness.answer('http://alpha:8642', ok('http://alpha:8642'));
    await tick();

    // `beta` is still probing, and its lane holds the stamp it was claimed
    // with: a committed wave never re-probes inside the interval.
    harness.startWave({ now: T0 + MIN_PROBE_INTERVAL_MS - 1 });
    await tick();

    expect(harness.probes).toEqual(['http://alpha:8642', 'http://beta:8642']);
  });

  test('a settled gateway is probed again once its 8s has elapsed', async () => {
    const harness = waveHarness([gateway('alpha')]);
    const first = harness.startWave();
    await harness.answer('http://alpha:8642', ok('http://alpha:8642'));
    await first.wave.settled;

    const second = harness.startWave({ now: T0 + MIN_PROBE_INTERVAL_MS });
    await tick();

    expect(harness.probes).toHaveLength(2);
    expect(harness.records.alpha.state).toBe('checking');
    void second;
  });
});

describe('the safety net for a lost wave', () => {
  /** A gateway whose debounce stamp is fresh, but whose claim never came back. */
  function lostClaim() {
    const harness = waveHarness([gateway('alpha')]);
    harness.ledger.lastProbeAt.alpha = T0;
    harness.ledger.checkingSince.alpha = T0;
    return harness;
  }

  test('a gateway checked for longer than the probe deadline plus 5s is due again', async () => {
    const harness = lostClaim();

    harness.startWave({ now: T0 + PROBE_STUCK_AFTER_MS });
    await tick();

    expect(harness.probes).toEqual(['http://alpha:8642']);
    expect(harness.records.alpha.state).toBe('checking');
  });

  test('the window is not reached a millisecond early, so the debounce still decides', async () => {
    const harness = lostClaim();
    // Inside the window: only the debounce can hold this gateway back, and it
    // must, or the row would be re-probed on every dependency change.
    harness.ledger.lastProbeAt.alpha = T0 + PROBE_STUCK_AFTER_MS - MIN_PROBE_INTERVAL_MS;

    harness.startWave({ now: T0 + PROBE_STUCK_AFTER_MS - 1 });
    await tick();

    expect(harness.probes).toEqual([]);
    expect(harness.records.alpha).toBeUndefined();
  });

  test('the planner asks about the claim even with a debounce stamp it would honour', () => {
    const plan = (now: number) =>
      planProbeWave({
        gateways: [gateway('alpha')],
        activeGatewayId: null,
        activeConnected: false,
        // A debounce the planner alone would honour, on both sides of the edge.
        lastProbeAt: { alpha: now - MIN_PROBE_INTERVAL_MS + 1 },
        checkingSince: { alpha: T0 },
        now,
        minIntervalMs: MIN_PROBE_INTERVAL_MS,
        stuckAfterMs: PROBE_STUCK_AFTER_MS,
      });

    expect(plan(T0 + PROBE_STUCK_AFTER_MS - 1)).toEqual([]);
    expect(plan(T0 + PROBE_STUCK_AFTER_MS).map((item) => item.id)).toEqual(['alpha']);
  });

  test('a gateway with no claim in flight is never treated as stuck', () => {
    const due = planProbeWave({
      gateways: [gateway('alpha')],
      activeGatewayId: null,
      activeConnected: false,
      lastProbeAt: { alpha: T0 },
      checkingSince: {},
      now: T0 + MIN_PROBE_INTERVAL_MS - 1,
      minIntervalMs: MIN_PROBE_INTERVAL_MS,
      stuckAfterMs: PROBE_STUCK_AFTER_MS,
    });
    expect(due).toEqual([]);
  });
});

describe('withoutWaveChecking', () => {
  const previous: Record<string, GatewayReachability> = {
    claimed: { gatewayId: 'claimed', url: 'http://claimed:8642', state: 'checking' },
    settled: {
      gatewayId: 'settled',
      url: 'http://settled:8642',
      state: 'reachable',
      latencyMs: 42,
      checkedAt: 5_000,
    },
  };

  test('a claimed row goes back to unknown, with no verdict invented', () => {
    const next = withoutWaveChecking(previous, [gateway('claimed')]);
    expect(next.claimed).toEqual({
      gatewayId: 'claimed',
      url: 'http://claimed:8642',
      state: 'unknown',
    });
  });

  test('a row another wave already settled is left alone', () => {
    const next = withoutWaveChecking(previous, [gateway('settled')]);
    expect(next.settled).toBe(previous.settled);
  });

  test('an empty list answers the same records', () => {
    expect(withoutWaveChecking(previous, [])).toEqual(previous);
  });
});

describe('reachabilityFromProbe', () => {
  test('a probe that answers is reachable, with its latency', () => {
    expect(reachabilityFromProbe(gateway('alpha'), ok('http://alpha:8642', 31))).toEqual({
      gatewayId: 'alpha',
      url: 'http://alpha:8642',
      state: 'reachable',
      latencyMs: 31,
      checkedAt: expect.any(Number),
    });
  });

  test('a probe that is refused is unreachable, carrying the reason', () => {
    expect(reachabilityFromProbe(gateway('alpha'), refused('http://alpha:8642', 'no route'))).toEqual({
      gatewayId: 'alpha',
      url: 'http://alpha:8642',
      state: 'unreachable',
      error: 'no route',
      checkedAt: expect.any(Number),
    });
  });
});

/**
 * The hook itself, driven through real React and real effect cleanup. The unit
 * harness above proves `startProbeWave` behaves; this proves the hook hands it
 * the cancel signal it depends on, in the order that matters.
 */
/**
 * The hook's probe is a fake whose every call parks until the test answers it,
 * so a dependency change can be made with every probe genuinely in flight.
 * Mocked at the top of the file because the hook is imported there.
 */
const mockProbeUrls: string[] = [];
const mockPending: { url: string; resolve: (result: ProbeResult) => void }[] = [];

jest.mock('@/lib/gateway/probe', () => ({
  probeGatewayUrl: (url: string) => {
    mockProbeUrls.push(url);
    return new Promise<ProbeResult>((resolve) => {
      mockPending.push({ url, resolve });
    });
  },
}));

describe('the hook, driven through a dependency change mid-probe', () => {
  let records: Record<string, GatewayReachability> = {};
  let render: (
    gateways: GatewayProfile[],
    activeGateway: GatewayProfile | null,
    status: ConnectionStatus,
  ) => void = () => undefined;

  function HookHost(props: {
    gateways: GatewayProfile[];
    activeGateway: GatewayProfile | null;
    status: ConnectionStatus;
  }) {
    records = useGatewayReachability(props);
    return null;
  }

  /** Answer the most recent probe of `url`, waiting for it to be issued. */
  async function answer(url: string, result: ProbeResult) {
    for (let i = 0; i < 8 && !mockPending.some((entry) => entry.url === url); i += 1) {
      await tick();
    }
    const gate = [...mockPending].reverse().find((entry) => entry.url === url);
    if (!gate) throw new Error(`no probe was issued for ${url}`);
    // The verdict lands as a state write, so it has to be flushed the way a
    // real probe answer would be.
    await act(async () => {
      gate.resolve(result);
    });
    await tick();
  }

  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    mockProbeUrls.length = 0;
    mockPending.length = 0;
    records = {};
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount();
      });
      renderer = null;
    }
  });

  test('a wave torn down mid-probe is re-probed, and the row ends with a verdict', async () => {
    const alpha = gateway('alpha');
    // A `gateways` identity change is one of the four effect dependencies, and
    // `persistGateway` produces exactly this on every connect.
    render = (gateways, activeGateway, status) => {
      void act(() => {
        renderer?.update(
          createElement(HookHost, { gateways, activeGateway, status }),
        );
      });
    };

    await act(async () => {
      renderer = create(createElement(HookHost, { gateways: [alpha], activeGateway: null, status: 'connecting' }));
    });
    await tick();
    expect(records.alpha.state).toBe('checking');

    // The status transition to `connected` cancels the wave with the probe
    // still in flight.
    render([{ ...alpha }], null, 'connected');
    await tick();

    await answer('http://alpha:8642', ok('http://alpha:8642', 17));

    expect(mockProbeUrls).toEqual(['http://alpha:8642', 'http://alpha:8642']);
    expect(records.alpha.state).toBe('reachable');
    expect(records.alpha.latencyMs).toBe(17);
  });

  test('the row never outlives its probes on "Checking"', async () => {
    const alpha = gateway('alpha');
    await act(async () => {
      renderer = create(createElement(HookHost, { gateways: [alpha], activeGateway: null, status: 'connecting' }));
    });
    await tick();
    expect(records.alpha.state).toBe('checking');

    // Two dependency changes in a row, each cancelling the wave before it
    // answers: the version this fixes left the row reading "Checking" for the
    // rest of the session, because the debounce ledger said it was already
    // probed and nothing was left to re-run the effect.
    await act(async () => {
      renderer?.update(createElement(HookHost, { gateways: [{ ...alpha }], activeGateway: null, status: 'reconnecting' }));
    });
    await tick();
    await act(async () => {
      renderer?.update(createElement(HookHost, { gateways: [{ ...alpha }], activeGateway: null, status: 'connecting' }));
    });
    await tick();

    await answer('http://alpha:8642', refused('http://alpha:8642', 'no route'));

    expect(records.alpha.state).toBe('unreachable');
    expect(records.alpha.error).toBe('no route');
  });
});

describe('the hook hands a torn-down wave its claim back', () => {
  const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const path = jest.requireActual('path') as { join(...parts: string[]): string };
  const hookSource = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'hooks', 'use-gateway-reachability.ts'), 'utf8')
    .replace(/\r\n/g, '\n');

  test('the cleanup releases the wave, which is the only ordering that un-debounces it', () => {
    // The claim has to go back in the cleanup and not after the probe settles:
    // the replacement effect body runs between the two, and it is that run's
    // planProbeWave which has to see the stranded gateway as due.
    expect(hookSource).toMatch(/return \(\) => \{\s*cancelled = true;[\s\S]*?wave\.release\(\);/);
  });

  test('the planner is told about in-flight probes and the stuck window', () => {
    expect(hookSource).toContain('checkingSince: ledgerRef.current.checkingSince,');
    expect(hookSource).toContain('const PROBE_STUCK_AFTER_MS = PROBE_TIMEOUT_MS + 5000;');
    expect(hookSource).toContain('stuckAfterMs: PROBE_STUCK_AFTER_MS,');
  });

  test('a released wave puts its rows back, so no row reads "Checking" for a probe that stopped', () => {
    expect(hookSource).toContain(
      'onReleased: (stranded) => setResults((previous) => withoutWaveChecking(previous, stranded)),',
    );
  });
});
