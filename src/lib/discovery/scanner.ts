// ─── Local discovery scanner ─────────────────────────────────────
// mDNS/Bonjour discovery was removed: react-native-zeroconf (legacy
// native module) crashed native builds under the New Architecture, and
// it is not bundled in Expo Go. The scanner now reports 'unavailable'
// and the app relies on manual gateway URLs (Tailscale / LAN IP), which
// auto-connect probing already covers.

import type { DiscoveredGateway, DiscoveryState } from '@/lib/discovery/types';

export function isNativeDiscoveryAvailable(): boolean {
  return false;
}

export class GatewayDiscoveryScanner {
  private listeners = new Set<(state: DiscoveryState) => void>();

  subscribe(listener: (state: DiscoveryState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  start() {
    this.emit({
      status: 'unavailable',
      gateways: [],
      error:
        'mDNS discovery is disabled in this build — add gateways by URL (Tailscale or LAN IP).',
      nativeAvailable: false,
    });
  }

  stop() {
    this.emit(this.snapshot('idle'));
  }

  private snapshot(status: DiscoveryState['status'] = 'idle'): DiscoveryState {
    return {
      status,
      gateways: [] as DiscoveredGateway[],
      nativeAvailable: false,
    };
  }

  private emit(state: DiscoveryState) {
    this.listeners.forEach((listener) => listener(state));
  }
}
