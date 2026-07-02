import { normalizeGatewayUrl } from '@/lib/gateway/url';
import { keyValueStorage } from '@/lib/storage/key-value';

import type { GatewayProfile } from '@/lib/gateway/types';

const GATEWAYS_KEY = 'versutus:gateways';
const ACTIVE_GATEWAY_KEY = 'versutus:active-gateway';

export async function loadGateways(): Promise<GatewayProfile[]> {
  const raw = await keyValueStorage.getItem(GATEWAYS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as GatewayProfile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveGateways(gateways: GatewayProfile[]): Promise<void> {
  await keyValueStorage.setItem(GATEWAYS_KEY, JSON.stringify(gateways));
}

export async function upsertGateway(gateway: GatewayProfile): Promise<GatewayProfile[]> {
  const gateways = await loadGateways();
  const index = gateways.findIndex((item) => item.id === gateway.id);
  if (index >= 0) gateways[index] = gateway;
  else gateways.unshift(gateway);
  await saveGateways(gateways);
  return gateways;
}

export async function removeGateway(id: string): Promise<GatewayProfile[]> {
  const gateways = (await loadGateways()).filter((item) => item.id !== id);
  await saveGateways(gateways);
  return gateways;
}

export async function loadActiveGatewayId(): Promise<string | null> {
  return keyValueStorage.getItem(ACTIVE_GATEWAY_KEY);
}

export async function saveActiveGatewayId(id: string | null): Promise<void> {
  if (!id) {
    await keyValueStorage.removeItem(ACTIVE_GATEWAY_KEY);
    return;
  }
  await keyValueStorage.setItem(ACTIVE_GATEWAY_KEY, id);
}

export { normalizeGatewayUrl } from '@/lib/gateway/url';

export function createGatewayProfile(input: {
  name: string;
  url: string;
  token?: string;
  bootstrapToken?: string;
  tlsFingerprint?: string;
  sessionKey?: string;
  agentId?: string;
  discoverySource?: GatewayProfile['discoverySource'];
}): GatewayProfile {
  const discoverySource =
    input.discoverySource ??
    (input.url.includes('.ts.net') || input.url.startsWith('wss://') ? 'tailscale' : 'manual');

  return {
    id: `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || 'My Gateway',
    url: normalizeGatewayUrl(input.url, {
      preferTls: discoverySource === 'tailscale' || input.url.startsWith('wss://'),
      tlsFingerprint: input.tlsFingerprint,
    }),
    token: input.token?.trim() || undefined,
    bootstrapToken: input.bootstrapToken?.trim() || undefined,
    tlsFingerprint: input.tlsFingerprint?.trim() || undefined,
    sessionKey: input.sessionKey?.trim() || 'agent:main:main',
    agentId: input.agentId?.trim() || 'main',
    discoverySource,
    createdAt: Date.now(),
  };
}
