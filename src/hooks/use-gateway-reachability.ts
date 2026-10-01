import { useEffect, useMemo, useRef, useState } from 'react';

import { probeGatewayUrl } from '@/lib/gateway/probe';
import {
  reachabilityFromProbe,
  startProbeWave,
  withWaveChecking,
  withoutWaveChecking,
  type ProbeLedger,
} from '@/lib/gateway/reachability-wave';
import type {
  GatewayReachability,
} from '@/lib/gateway/dashboard';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

// A DERP/Tailscale path measures 0.9–1.7s RTT with loss; 3–3.5s already gives
// false negatives, so a reachable tailnet gateway is probed with 6s.
const PROBE_TIMEOUT_MS = 6000;
const MIN_PROBE_INTERVAL_MS = 8000; // debounce for user-friendly automatic polling
// A probe that has read "Checking" for longer than its own deadline plus a
// margin is due again whatever the debounce ledger says — the safety net for a
// wave lost some other way (a throw, an early unmount) with nothing left to
// re-run the effect.
const PROBE_STUCK_AFTER_MS = PROBE_TIMEOUT_MS + 5000;

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
  // Probe bookkeeping — a ref, so it doesn't retrigger the wave — and the two
  // ledgers a wave claims into: when each gateway was last claimed (the
  // debounce) and when its in-flight probe started.
  const ledgerRef = useRef<ProbeLedger>({ lastProbeAt: {}, checkingSince: {} });
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

    const wave = startProbeWave({
      plan: {
        gateways,
        activeGatewayId: activeGateway?.id ?? null,
        activeConnected: status === 'connected',
        lastProbeAt: ledgerRef.current.lastProbeAt,
        checkingSince: ledgerRef.current.checkingSince,
        now: Date.now(),
        minIntervalMs: MIN_PROBE_INTERVAL_MS,
        stuckAfterMs: PROBE_STUCK_AFTER_MS,
      },
      ledger: ledgerRef.current,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      isCancelled: () => cancelled,
      // Probes ride a small concurrency cap instead of one-at-a-time: the
      // sequential wave held every row's verdict hostage to 6s x N of lossy
      // hops before it reached the end of the roster.
      probe: (url, timeoutMs) => probeGatewayUrl(url, timeoutMs),
      // One record-replacing write marks the WHOLE wave checking — the ledger is
      // stamped up front for the same reason — so a wave of N due gateways
      // costs one extra render instead of N.
      onChecking: (due) => setResults((previous) => withWaveChecking(previous, due)),
      onVerdict: (gateway, result) =>
        setResults((previous) => ({
          ...previous,
          [gateway.id]: reachabilityFromProbe(gateway, result),
        })),
      onReleased: (stranded) => setResults((previous) => withoutWaveChecking(previous, stranded)),
    });

    void wave.settled;

    return () => {
      cancelled = true;
      // The claim is given back HERE, before the replacement effect runs: this
      // cleanup is the only point at which the ledger is unwound before the
      // next `planProbeWave` reads it, and that read is what makes the
      // gateways this wave stranded due again instead of debounced.
      wave.release();
    };
  }, [activeGateway?.id, gateways, signature, status]);

  return results;
}
