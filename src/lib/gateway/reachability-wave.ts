import type { GatewayProfile } from '@/lib/gateway/types';
import type { GatewayReachability } from '@/lib/gateway/dashboard';

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
 * Decide which saved gateways a reachability wave owes a probe right now.
 *
 * Mirrors the rules the hook has always applied, extracted so they stay
 * pinned by tests:
 * - the active gateway while its connection is `connected` is trusted live
 *   (the monitor owns its truth) and is never probed;
 * - a gateway probed less than `minIntervalMs` ago waits for the next wave;
 * - everything else is due, in roster order.
 */
export function planProbeWave({
  gateways,
  activeGatewayId,
  activeConnected,
  lastProbeAt,
  now,
  minIntervalMs,
}: {
  gateways: GatewayProfile[];
  activeGatewayId: string | null;
  activeConnected: boolean;
  lastProbeAt: Record<string, number>;
  now: number;
  minIntervalMs: number;
}): GatewayProfile[] {
  return gateways.filter((gateway) => {
    if (activeConnected && gateway.id === activeGatewayId) return false;
    const last = lastProbeAt[gateway.id] ?? 0;
    return now - last >= minIntervalMs;
  });
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
