import { useEffect, useMemo, useState } from 'react';

import { probeGatewayUrl } from '@/lib/gateway/probe';
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
  const [lastProbeAt, setLastProbeAt] = useState<Record<string, number>>({});
  const signature = useMemo(
    () => gateways.map((gateway) => `${gateway.id}:${gateway.url}`).join('|'),
    [gateways],
  );

  useEffect(() => {
    let cancelled = false;

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

    async function probeSavedGateways() {
      const now = Date.now();
      for (const gateway of gateways) {
        const active = activeGateway?.id === gateway.id;
        if (cancelled || (active && status === 'connected')) continue;

        const last = lastProbeAt[gateway.id] ?? 0;
        if (now - last < MIN_PROBE_INTERVAL_MS) continue;

        setReachability(gateway, 'checking');
        setLastProbeAt((prev) => ({ ...prev, [gateway.id]: now }));

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
      }
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
