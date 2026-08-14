// Provider records are not child gateways. Stored `parentId::providerId`
// profiles are retired back onto the parent Gate; model choice is
// `{providerId, modelId}` on that parent. Hermes/agent profiles that are
// not provider children are left alone.

import type { GatewayManifestProvider } from '@/lib/portal/manifest';
import type { GatewayProfile } from '@/lib/gateway/types';

export function childProfileId(parentId: string, providerId: string): string {
  return `${parentId}::${providerId}`;
}

export function isProviderChildProfile(profile: GatewayProfile, parentId: string): boolean {
  return profile.parentId === parentId && profile.id.startsWith(`${parentId}::`);
}

/**
 * Retire provider child profiles. Providers stay on the parent Gate.
 * Direct Hermes/agent profiles (no parentId prefix) are not touched.
 */
export function reconcileChildProfiles(
  parent: GatewayProfile,
  _providers: GatewayManifestProvider[],
  allGateways: GatewayProfile[],
): { toUpsert: GatewayProfile[]; toRemove: string[] } {
  const toRemove = allGateways
    .filter((profile) => isProviderChildProfile(profile, parent.id))
    .map((profile) => profile.id);
  return { toUpsert: [], toRemove };
}

export async function syncChildProfiles(
  parent: GatewayProfile,
  providers: GatewayManifestProvider[],
): Promise<GatewayProfile[]> {
  const { loadGateways, saveGateways } = await import('@/lib/gateway/storage');
  const current = await loadGateways();
  const { toRemove } = reconcileChildProfiles(parent, providers, current);
  if (toRemove.length === 0) return current;

  const removeSet = new Set(toRemove);
  const next = current.filter((profile) => !removeSet.has(profile.id));
  await saveGateways(next);
  return next;
}
