import type { GatewayProfile } from '@/lib/gateway/types';
import type { GatewayReachability } from '@/lib/gateway/dashboard';
import type { ProbeResult } from '@/lib/gateway/probe';

/**
 * How many saved-gateway health probes may be in flight at once during one
 * reachability wave. Probes are tiny GET /health requests with a 1.8s
 * timeout; probing them one at a time made a full dashboard verdict take up
 * to 1.8s x N on lossy Tailscale hops. A small cap turns that into about
 * ceil(N / cap) rounds without opening N simultaneous sockets on the phone.
 */
export const PROBE_WAVE_CONCURRENCY = 3;

/**
 * Mark a whole wave of due gateways `checking` in ONE record-replacing fold,
 * the way the sequential loop did when it flipped each one just before
 * probing it (state flips, and each record's own `checkedAt`/`latencyMs`/
 * `error` ride through unchanged so a stale verdict's stamp and latency are
 * never rewritten by the mere fact of re-probing). The wave's debounce ledger
 * is stamped up front for the same reason: one state write covers the whole
 * wave instead of one per due gateway.
 */
export function withWaveChecking(
  previous: Record<string, GatewayReachability>,
  due: readonly GatewayProfile[],
): Record<string, GatewayReachability> {
  const next = { ...previous };
  for (const gateway of due) {
    next[gateway.id] = {
      gatewayId: gateway.id,
      url: gateway.url,
      state: 'checking',
      checkedAt: previous[gateway.id]?.checkedAt,
      latencyMs: previous[gateway.id]?.latencyMs,
      error: previous[gateway.id]?.error,
    };
  }
  return next;
}

/**
 * The other half of `withWaveChecking`: give a wave's gateways back once
 * nothing is probing them any more.
 *
 * A cancelled wave is the case that matters — the effect that started it is
 * torn down mid-probe, the worker returns without a verdict, and the row is
 * left reading "Checking" for a probe that no longer exists. There is no
 * verdict to put back (the wave never wrote one), so the honest state is
 * `unknown`; the row is due again on the very next wave, because the debounce
 * stamp went with the claim.
 *
 * A record that is not `checking` belongs to another wave or a live verdict
 * and is left exactly as it is.
 */
export function withoutWaveChecking(
  previous: Record<string, GatewayReachability>,
  due: readonly GatewayProfile[],
): Record<string, GatewayReachability> {
  const next = { ...previous };
  for (const gateway of due) {
    if (next[gateway.id]?.state !== 'checking') continue;
    next[gateway.id] = { gatewayId: gateway.id, url: gateway.url, state: 'unknown' };
  }
  return next;
}

/** The record one settled probe writes, stamped with when it was taken. */
export function reachabilityFromProbe(
  gateway: GatewayProfile,
  result: ProbeResult,
): GatewayReachability {
  return result.ok
    ? {
        gatewayId: gateway.id,
        url: gateway.url,
        state: 'reachable',
        latencyMs: result.latencyMs,
        checkedAt: Date.now(),
      }
    : {
        gatewayId: gateway.id,
        url: gateway.url,
        state: 'unreachable',
        checkedAt: Date.now(),
        error: result.error,
      };
}

/** What one wave plans, and the rules it plans them by. */
export type ProbeWavePlan = {
  gateways: GatewayProfile[];
  activeGatewayId: string | null;
  activeConnected: boolean;
  /** When each gateway was last CLAIMED by a wave, by id. */
  lastProbeAt: Record<string, number>;
  /**
   * When each gateway's in-flight probe started, by id. A gateway that has
   * been `checking` for `stuckAfterMs` is due again whatever the debounce
   * stamp says. Omitted means no probe is known to be in flight.
   */
  checkingSince?: Record<string, number>;
  now: number;
  minIntervalMs: number;
  /** The `checking` age that makes a gateway due again. Unset/0 disables it. */
  stuckAfterMs?: number;
};

/**
 * Decide which saved gateways a reachability wave owes a probe right now.
 *
 * Mirrors the rules the hook has always applied, extracted so they stay
 * pinned by tests:
 * - the active gateway while its connection is `connected` is trusted live
 *   (the monitor owns its truth) and is never probed;
 * - a gateway probed less than `minIntervalMs` ago waits for the next wave;
 * - a gateway whose probe has been running longer than `stuckAfterMs` is due
 *   regardless, because a wave that was lost must not hold the debounce;
 * - everything else is due, in roster order.
 */
export function planProbeWave({
  gateways,
  activeGatewayId,
  activeConnected,
  lastProbeAt,
  checkingSince,
  now,
  minIntervalMs,
  stuckAfterMs,
}: ProbeWavePlan): GatewayProfile[] {
  const stuckAfter = stuckAfterMs ?? 0;
  return gateways.filter((gateway) => {
    if (activeConnected && gateway.id === activeGatewayId) return false;
    const checkingSinceAt = checkingSince?.[gateway.id];
    if (stuckAfter > 0 && checkingSinceAt !== undefined && now - checkingSinceAt >= stuckAfter) {
      return true;
    }
    const last = lastProbeAt[gateway.id] ?? 0;
    return now - last >= minIntervalMs;
  });
}

/** The ledgers one hook keeps for the waves it runs, by gateway id. */
export type ProbeLedger = {
  lastProbeAt: Record<string, number>;
  checkingSince: Record<string, number>;
};

/** A running wave: its own completion, and the claim it can hand back. */
export type ProbeWave = {
  /** Settles when every probe has answered, or once the wave gave its claim back. */
  settled: Promise<void>;
  /**
   * Give back every claim no probe answered for: the debounce and in-flight
   * stamps go, and the rows stop reading "Checking".
   *
   * The effect cleanup calls this, and the ordering is the whole fix — the
   * cleanup runs before the replacement effect body, so the stranded gateways
   * are due again by the time `planProbeWave` reads the ledger. Without it the
   * replacement wave plans an empty `due`, keeps the stale `checking` record,
   * and there is no interval to rescue it. Calling it twice is a no-op.
   */
  release: () => void;
};

/**
 * Run one reachability wave: plan it, mark the whole wave `checking` in a
 * single write, probe it under the concurrency cap, and report each verdict as
 * it settles.
 *
 * The wave owns nothing the caller cannot reuse — the ledgers are the caller's
 * objects, so a claim this wave still holds is visible to the next one.
 */
export function startProbeWave({
  plan,
  ledger,
  probeTimeoutMs,
  isCancelled,
  probe,
  onChecking,
  onVerdict,
  onReleased,
}: {
  plan: ProbeWavePlan;
  ledger: ProbeLedger;
  probeTimeoutMs: number;
  /** True once the effect that started this wave has been torn down. */
  isCancelled: () => boolean;
  probe: (url: string, timeoutMs: number) => Promise<ProbeResult>;
  onChecking: (due: readonly GatewayProfile[]) => void;
  onVerdict: (gateway: GatewayProfile, result: ProbeResult) => void;
  onReleased: (stranded: readonly GatewayProfile[]) => void;
}): ProbeWave {
  const due = planProbeWave(plan);
  // Nothing is owed a probe, so there is no claim to hand back later.
  if (due.length === 0) return { settled: Promise.resolve(), release: () => {} };

  // The ledger is stamped for the whole wave up front — the sequential loop
  // this replaced reused this same `now` for every stamp too — so a dependency
  // that changes while the wave drains cannot plan the same gateway twice.
  // Each stamp belongs to its wave: `release` gives back the ones no probe
  // answered for, so a cancelled wave never debounces a probe that never ran.
  const outstanding = new Set<string>();
  for (const gateway of due) {
    ledger.lastProbeAt[gateway.id] = plan.now;
    ledger.checkingSince[gateway.id] = plan.now;
    outstanding.add(gateway.id);
  }
  onChecking(due);

  const release = () => {
    if (outstanding.size === 0) return;
    const stranded = due.filter((gateway) => outstanding.has(gateway.id));
    outstanding.clear();
    for (const gateway of stranded) {
      delete ledger.lastProbeAt[gateway.id];
      delete ledger.checkingSince[gateway.id];
    }
    onReleased(stranded);
  };

  const settled = runCapped(due, PROBE_WAVE_CONCURRENCY, async (gateway) => {
    if (isCancelled()) return;
    const result = await probe(gateway.url, probeTimeoutMs);
    if (isCancelled()) return;
    // A verdict is written, so this gateway's stamp is a real debounce and it
    // is no longer in flight.
    outstanding.delete(gateway.id);
    delete ledger.checkingSince[gateway.id];
    onVerdict(gateway, result);
  }).then(
    // A wave that ends with gateways no probe answered for — cancelled, or a
    // probe that threw — gives its claim back instead of debouncing a verdict
    // that does not exist. The refusal is not swallowed silently: the rows go
    // back to `unknown` and the next wave retries them.
    () => release(),
    () => release(),
  );

  return { settled, release };
}

/**
 * Run `worker` over every item with at most `concurrency` calls in flight;
 * as one settles the next starts, so the pool drains without gaps.
 *
 * Results keep input order no matter the completion order. A rejecting
 * worker rejects the whole run (the probe worker itself never rejects — it
 * returns typed results — but the contract is stated here so future callers
 * know there is no silent swallowing).
 */
export async function runCapped<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  // Hostile caps clamp to a single lane instead of zero or negative pools.
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      // The cursor read-and-advance happens synchronously before any await,
      // so two lanes can never claim the same index.
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}
