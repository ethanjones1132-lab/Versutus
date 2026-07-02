export type DiscoveredGateway = {
  id: string;
  name: string;
  host: string;
  port: number;
  url: string;
  tlsFingerprint?: string;
  tailnetDns?: string;
  transport?: string;
  source: 'local' | 'wide-area' | 'manual';
  txt: Record<string, string>;
  lastSeenAt: number;
};

export type DiscoveryStatus = 'idle' | 'scanning' | 'unavailable' | 'error';

export type DiscoveryState = {
  status: DiscoveryStatus;
  gateways: DiscoveredGateway[];
  error?: string;
  nativeAvailable: boolean;
};