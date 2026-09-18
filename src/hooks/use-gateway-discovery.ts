import { useEffect, useState } from 'react';

import { GatewayDiscoveryScanner } from '@/lib/discovery/scanner';

import type { DiscoveryState } from '@/lib/discovery/types';

let sharedScanner: GatewayDiscoveryScanner | null = null;
let activeSubscribers = 0;

function getScanner() {
  if (!sharedScanner) sharedScanner = new GatewayDiscoveryScanner();
  return sharedScanner;
}

export function useGatewayDiscovery(enabled = true) {
  const [state, setState] = useState<DiscoveryState>({
    status: 'idle',
    gateways: [],
    nativeAvailable: false,
  });

  useEffect(() => {
    if (!enabled) return;
    const scanner = getScanner();
    const unsubscribe = scanner.subscribe(setState);
    activeSubscribers += 1;
    scanner.start();
    return () => {
      unsubscribe();
      activeSubscribers -= 1;
      if (activeSubscribers === 0) scanner.stop();
    };
  }, [enabled]);

  return {
    ...state,
    rescan: () => {
      const scanner = getScanner();
      scanner.stop();
      scanner.start();
    },
    stop: () => getScanner().stop(),
  };
}