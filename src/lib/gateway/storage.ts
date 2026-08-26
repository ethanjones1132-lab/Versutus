import { normalizeGatewayUrl } from '@/lib/gateway/url';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';

import type { GatewayProfile } from '@/lib/gateway/types';

const GATEWAYS_KEY = 'versutus:gateways';
const ACTIVE_GATEWAY_KEY = 'versutus:active-gateway';

// upsert/remove/save are read-modify-write over one JSON array. Two overlapping
// mutations each load the same snapshot and the later write erases the earlier
// one's pin, token, or newly added gateway. Serialize through a single promise
// chain so each mutation reads what the previous one wrote. Reads stay off the
// queue: a load racing a write may observe the pre-write state, which is
// acceptable, while keeping loadGateways off the queue avoids adding latency
// to connect.
let mutationQueueTail: Promise<void> = Promise.resolve();

function enqueueStoreMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationQueueTail.then(task);
  // A failed mutation must reject its own caller without poisoning the queue:
  // the tail always settles resolved so the next mutation still runs.
  mutationQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function writeGateways(gateways: GatewayProfile[]): Promise<void> {
  await secureKeyValueStorage.setItem(GATEWAYS_KEY, JSON.stringify(gateways));
}

export async function loadGateways(): Promise<GatewayProfile[]> {
  const raw = await secureKeyValueStorage.getItem(GATEWAYS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as GatewayProfile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveGateways(gateways: GatewayProfile[]): Promise<void> {
  await enqueueStoreMutation(() => writeGateways(gateways));
}

export async function upsertGateway(gateway: GatewayProfile): Promise<GatewayProfile[]> {
  return enqueueStoreMutation(async () => {
    const gateways = await loadGateways();
    const index = gateways.findIndex((item) => item.id === gateway.id);
    if (index >= 0) gateways[index] = gateway;
    else gateways.unshift(gateway);
    await writeGateways(gateways);
    return gateways;
  });
}

export async function removeGateway(id: string): Promise<GatewayProfile[]> {
  // Cascade: provider child profiles materialised from a parent gate's
  // providers[] must not outlive the parent they were synced from.
  return enqueueStoreMutation(async () => {
    const gateways = (await loadGateways()).filter(
      (item) => item.id !== id && item.parentId !== id,
    );
    await writeGateways(gateways);
    return gateways;
  });
}

export async function loadActiveGatewayId(): Promise<string | null> {
  return secureKeyValueStorage.getItem(ACTIVE_GATEWAY_KEY);
}

export async function saveActiveGatewayId(id: string | null): Promise<void> {
  if (!id) {
    await secureKeyValueStorage.removeItem(ACTIVE_GATEWAY_KEY);
    return;
  }
  await secureKeyValueStorage.setItem(ACTIVE_GATEWAY_KEY, id);
}

export { normalizeGatewayUrl } from '@/lib/gateway/url';

export function createGatewayProfile(input: {
  name: string;
  url: string;
  kind?: GatewayProfile['kind'];
  token?: string;
  bootstrapToken?: string;
  tlsFingerprint?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  discoverySource?: GatewayProfile['discoverySource'];
}): GatewayProfile {
  const discoverySource =
    input.discoverySource ??
    (input.url.includes('.ts.net') || input.url.startsWith('https://') ? 'tailscale' : 'manual');

  return {
    id: `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || 'My Gateway',
    url: normalizeGatewayUrl(input.url),
    kind: input.kind,
    token: input.token?.trim() || undefined,
    tlsFingerprint: input.tlsFingerprint?.trim() || undefined,
    createdAt: Date.now(),
    sessionKey: input.sessionKey?.trim(),
    sessionId: input.sessionId?.trim(),
    agentId: input.agentId?.trim() || undefined,
    discoverySource,
  };
}
