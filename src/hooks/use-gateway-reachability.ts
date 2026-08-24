import { useEffect, useMemo, useRef, useState } from 'react';

import { probeGatewayUrl } from '@/lib/gateway/probe';
import {
  PROBE_WAVE_CONCURRENCY,
  planProbeWave,
  runCapped,
} from '@/lib/gateway/reachability-wave';
import type {
  GatewayReachability,
  GatewayReachabilityState,
} from '@/lib/gateway/dashboard';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

const PROBE_TIMEOUT_MS = 1800;
const MIN_PROBE_INTERVAL_MS = 8000; // debounce for user-friendly automatic polling

export function useGatewayReachability({
  gateways,
  activeGateway,
  status,
}: {
  gateways: GatewayProfile[];
  activeGateway: GatewayProfile | null;
  status: ConnectionStatus;
}) {
  const [results, setResults] = useState<Record<string, GatewayReachability>>({});
  // Debounce ledger — a ref so probe bookkeeping doesn't retrigger the wave.
  const lastProbeAtRef = useRef<Record<string, number>>({});
  const signature = useMemo(
    () => gateways.map((gateway) => `${gateway.id}:${gateway.url}`).join('|'),
    [gateways],
  );

  // Initialize results when the gateway set / active / status changes (derived
  // during render rather than in an effect, per React guidance).
  const adjustmentKey = `${signature}|${activeGateway?.id ?? ''}|${status}`;
  const [prevAdjustmentKey, setPrevAdjustmentKey] = useState(adjustmentKey);
  if (prevAdjustmentKey !== adjustmentKey) {
    setPrevAdjustmentKey(adjustmentKey);
    setResults((previous) => {
      const next: Record<string, GatewayReachability> = {};
      for (const gateway of gateways) {
        const active = activeGateway?.id === gateway.id;
        if (active && status === 'connected') {
          next[gateway.id] = {
            gatewayId: gateway.id,
            url: gateway.url,
            state: 'connected',
            checkedAt: Date.now(),
          };
        } else {
          next[gateway.id] = previous[gateway.id] ?? {
            gatewayId: gateway.id,
            url: gateway.url,
            state: 'unknown',
          };
        }
      }
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function probeSavedGateways() {
      const now = Date.now();
      // Which gateways this wave owes a probe, by the same rules the
      // sequential loop always applied (skip the connected-active gateway,
      // debounce anything probed within MIN_PROBE_INTERVAL_MS).
      const due = planProbeWave({
        gateways,
        activeGatewayId: activeGateway?.id ?? null,
        activeConnected: status === 'connected',
        lastProbeAt: lastProbeAtRef.current,
        now,
        minIntervalMs: MIN_PROBE_INTERVAL_MS,
      });
      // Stamp the whole wave's debounce ledger up front — the old loop
      // reused this same `now` for every stamp too, so a committed wave
      // never re-probes within the interval no matter how fast it drains.
      lastProbeAtRef.current = {
        ...lastProbeAtRef.current,
        ...Object.fromEntries(due.map((gateway) => [gateway.id, now])),
      };

      // Probes ride a small concurrency cap instead of one-at-a-time: the
      // sequential wave held every row's verdict hostage to 1.8s x N of
      // lossy hops before it reached the end of the roster.
      await runCapped(due, PROBE_WAVE_CONCURRENCY, async (gateway) => {
        if (cancelled) return;
        setReachability(gateway, 'checking');

        const result = await probeGatewayUrl(gateway.url, PROBE_TIMEOUT_MS);
        if (cancelled) return;

        if (result.ok) {
          setResults((previous) => ({
            ...previous,
            [gateway.id]: {
              gatewayId: gateway.id,
              url: gateway.url,
              state: 'reachable',
              latencyMs: result.latencyMs,
              checkedAt: Date.now(),
            },
          }));
        } else {
          setResults((previous) => ({
            ...previous,
            [gateway.id]: {
              gatewayId: gateway.id,
              url: gateway.url,
              state: 'unreachable',
              checkedAt: Date.now(),
              error: result.error,
            },
          }));
        }
      });
    }

    void probeSavedGateways();

    return () => {
      cancelled = true;
    };

    function setReachability(gateway: GatewayProfile, state: GatewayReachabilityState) {
      setResults((previous) => ({
        ...previous,
        [gateway.id]: {
          gatewayId: gateway.id,
          url: gateway.url,
          state,
          checkedAt: previous[gateway.id]?.checkedAt,
          latencyMs: previous[gateway.id]?.latencyMs,
          error: previous[gateway.id]?.error,
        },
      }));
    }
  }, [activeGateway?.id, gateways, signature, status]);

  return results;
}
