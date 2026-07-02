import { buildGatewayUrlFromBeacon } from '@/lib/gateway/url';

import type { DiscoveredGateway } from '@/lib/discovery/types';

export const OPENCLAW_GATEWAY_SERVICE_TYPE = 'openclaw-gw';
export const OPENCLAW_GATEWAY_SERVICE = '_openclaw-gw._tcp';

export function decodeBonjourName(value: string): string {
  return value.replace(/\\(\d{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 10)),
  );
}

export function parseTxtRecord(txt: Record<string, string> | string[] | undefined): Record<string, string> {
  if (!txt) return {};
  if (Array.isArray(txt)) {
    const out: Record<string, string> = {};
    for (const entry of txt) {
      const index = entry.indexOf('=');
      if (index <= 0) continue;
      out[entry.slice(0, index)] = entry.slice(index + 1);
    }
    return out;
  }
  return txt;
}

export function beaconFromZeroconfService(
  service: {
    name: string;
    host?: string;
    addresses?: string[];
    port: number;
    txt?: Record<string, string> | string[];
  },
  source: DiscoveredGateway['source'] = 'local',
): DiscoveredGateway | null {
  const host = service.host || service.addresses?.[0];
  if (!host || !service.port) return null;

  const txt = parseTxtRecord(service.txt);
  const { url, tlsFingerprint, displayName } = buildGatewayUrlFromBeacon({
    host,
    port: service.port,
    txt,
  });

  const name = decodeBonjourName(displayName || txt.displayName || service.name);

  return {
    id: `${source}:${name}:${host}:${service.port}`,
    name,
    host,
    port: service.port,
    url,
    tlsFingerprint,
    tailnetDns: txt.tailnetDns,
    transport: txt.transport,
    source,
    txt,
    lastSeenAt: Date.now(),
  };
}