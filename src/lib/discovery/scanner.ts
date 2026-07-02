import { Platform } from 'react-native';

import {
  beaconFromZeroconfService,
  OPENCLAW_GATEWAY_SERVICE,
  OPENCLAW_GATEWAY_SERVICE_TYPE,
} from '@/lib/discovery/beacon';

import type { DiscoveredGateway, DiscoveryState } from '@/lib/discovery/types';

type ZeroconfService = {
  name: string;
  host?: string;
  addresses?: string[];
  port: number;
  txt?: Record<string, string> | string[];
};

type ZeroconfModule = {
  scan: (type: string, protocol: string, domain: string) => void;
  stop: () => void;
  on: (event: string, callback: (service: ZeroconfService) => void) => void;
  removeListener: (event: string, callback: (service: ZeroconfService) => void) => void;
};

const SCAN_DOMAINS = ['local.'];

let zeroconfModule: ZeroconfModule | null | undefined;

function loadZeroconf(): ZeroconfModule | null {
  if (Platform.OS === 'web') return null;
  if (zeroconfModule !== undefined) return zeroconfModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Zeroconf = require('react-native-zeroconf').default as new () => ZeroconfModule;
    zeroconfModule = new Zeroconf();
    return zeroconfModule;
  } catch {
    zeroconfModule = null;
    return null;
  }
}

export function isNativeDiscoveryAvailable(): boolean {
  return loadZeroconf() !== null;
}

export class GatewayDiscoveryScanner {
  private zeroconf = loadZeroconf();
  private gateways = new Map<string, DiscoveredGateway>();
  private listeners = new Set<(state: DiscoveryState) => void>();
  private scanning = false;
  private resolvedHandler: ((service: ZeroconfService) => void) | null = null;
  private removedHandler: ((service: ZeroconfService) => void) | null = null;

  subscribe(listener: (state: DiscoveryState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  start() {
    if (!this.zeroconf) {
      this.emit({
        status: 'unavailable',
        gateways: [],
        error: 'Bonjour requires a native dev build (npx expo prebuild && npx expo run:ios/android).',
        nativeAvailable: false,
      });
      return;
    }

    if (this.scanning) return;
    this.scanning = true;
    this.gateways.clear();
    this.emit({ status: 'scanning', gateways: [], nativeAvailable: true });

    this.resolvedHandler = (service) => {
      const beacon = beaconFromZeroconfService(service, 'local');
      if (!beacon) return;
      this.gateways.set(beacon.id, beacon);
      this.emit(this.snapshot('scanning'));
    };

    this.removedHandler = (service) => {
      const beacon = beaconFromZeroconfService(service, 'local');
      if (!beacon) return;
      this.gateways.delete(beacon.id);
      this.emit(this.snapshot('scanning'));
    };

    this.zeroconf.on('resolved', this.resolvedHandler);
    this.zeroconf.on('remove', this.removedHandler);

    const serviceTypes = [
      OPENCLAW_GATEWAY_SERVICE_TYPE,
      OPENCLAW_GATEWAY_SERVICE, // full _service._proto form for broader compatibility
    ];

    for (const domain of SCAN_DOMAINS) {
      for (const svc of serviceTypes) {
        try {
          this.zeroconf.scan(svc, 'tcp', domain);
        } catch (error) {
          // Only surface the last error; many libs are tolerant of one form failing
          if (svc === serviceTypes[serviceTypes.length - 1]) {
            this.emit({
              status: 'error',
              gateways: [],
              error: error instanceof Error ? error.message : String(error),
              nativeAvailable: true,
            });
          }
        }
      }
    }
  }

  stop() {
    if (!this.zeroconf) return;
    if (this.resolvedHandler) this.zeroconf.removeListener('resolved', this.resolvedHandler);
    if (this.removedHandler) this.zeroconf.removeListener('remove', this.removedHandler);
    try {
      this.zeroconf.stop();
    } catch {
      // ignore
    }
    this.scanning = false;
    this.emit(this.snapshot('idle'));
  }

  private snapshot(status?: DiscoveryState['status']): DiscoveryState {
    return {
      status: status ?? (this.scanning ? 'scanning' : 'idle'),
      gateways: [...this.gateways.values()].sort((a, b) => a.name.localeCompare(b.name)),
      nativeAvailable: this.zeroconf !== null,
    };
  }

  private emit(state: DiscoveryState) {
    for (const listener of this.listeners) listener(state);
  }
}