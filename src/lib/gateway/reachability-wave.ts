import type { GatewayProfile } from '@/lib/gateway/types';

/**
 * How many saved-gateway health probes may be in flight at once during one
 * reachability wave. Probes are tiny GET /health requests with a 1.8s
 * timeout; probing them one at a time made a full dashboard verdict take up
 * to 1.8s x N on lossy Tailscale hops. A small cap turns that into about
 * ceil(N / cap) rounds without opening N simultaneous sockets on the phone.
 */
export const PROBE_WAVE_CONCURRENCY = 3;

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
