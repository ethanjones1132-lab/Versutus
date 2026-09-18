import { sanitizeHeaderValue } from '@/lib/gateway/http-transport';
import { collapseDuplicateGateways, mergeIntoExistingGateway } from '@/lib/gateway/profile-dedupe';
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

/**
 * A stored token or session key is a header value on every request. One saved
 * with a trailing `\r` (a pasted line, an older save path that did not trim)
 * made OkHttp refuse the terminal and hands-free calls outright, while chat
 * worked because HttpTransport cleans its own copy. Clean it once, on load, so
 * every consumer reads a value that is safe to send.
 */
function withCleanCredentials(profile: GatewayProfile): GatewayProfile {
  const token = sanitizeHeaderValue(profile.token) || undefined;
  const sessionKey = sanitizeHeaderValue(profile.sessionKey) || undefined;
  if (token === profile.token && sessionKey === profile.sessionKey) return profile;
  return { ...profile, token, sessionKey };
}

export async function loadGateways(): Promise<GatewayProfile[]> {
  const raw = await secureKeyValueStorage.getItem(GATEWAYS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as GatewayProfile[];
    return Array.isArray(parsed) ? parsed.map(withCleanCredentials) : [];
  } catch {
    return [];
  }
}

export async function saveGateways(gateways: GatewayProfile[]): Promise<void> {
  await enqueueStoreMutation(() => writeGateways(gateways));
}

export async function removeGatewayIds(ids: readonly string[]): Promise<GatewayProfile[]> {
  const removeSet = new Set(ids);
  if (removeSet.size === 0) return loadGateways();
  return enqueueStoreMutation(async () => {
    const gateways = (await loadGateways()).filter((item) => !removeSet.has(item.id));
    await writeGateways(gateways);
    return gateways;
  });
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

/**
 * Add a profile, merging it into a saved profile for the same gateway rather
 * than creating a second one (profile-dedupe.ts). Returns the profile that is
 * actually stored — the caller must connect with THAT, not the one it built.
 */
export async function addGatewayProfile(
  profile: GatewayProfile,
): Promise<{ profile: GatewayProfile; gateways: GatewayProfile[] }> {
  return enqueueStoreMutation(async () => {
    const merged = mergeIntoExistingGateway(await loadGateways(), profile);
    await writeGateways(merged.gateways);
    return merged;
  });
}

/**
 * Collapse duplicate profiles already saved, once, at startup: keep the one
 * that can authenticate and re-point the active id if it was a duplicate.
 * Writes only when something actually changed.
 */
export async function repairDuplicateGateways(): Promise<{ gateways: GatewayProfile[]; activeId: string | null }> {
  return enqueueStoreMutation(async () => {
    const [gateways, activeId] = await Promise.all([
      loadGateways(),
      secureKeyValueStorage.getItem(ACTIVE_GATEWAY_KEY),
    ]);
    const collapsed = collapseDuplicateGateways(gateways, activeId);
    if (collapsed.changed) {
      await writeGateways(collapsed.gateways);
      if (collapsed.activeId && collapsed.activeId !== activeId) {
        await secureKeyValueStorage.setItem(ACTIVE_GATEWAY_KEY, collapsed.activeId);
      }
    }
    return { gateways: collapsed.gateways, activeId: collapsed.activeId };
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
