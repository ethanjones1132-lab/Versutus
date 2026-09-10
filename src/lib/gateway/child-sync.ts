// Provider records are not child gateways. Stored `parentId::providerId`
// profiles are retired back onto the parent Gate; model choice is
// `{providerId, modelId}` on that parent. Hermes/agent profiles that are
// not provider children are left alone.

import { loadGateways, removeGatewayIds } from '@/lib/gateway/storage';
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

/**
 * A retire reports itself. `removedIds` are real, connectable gateway ids —
 * the device stores keyed by them (`versutus:transcript:<id>:*` and the
 * session-label blob) outlive the profile otherwise, the same way a deleted
 * profile's would, so the caller retires those stores beside the profile.
 */
export type ChildProfileSync = {
  gateways: GatewayProfile[];
  removedIds: string[];
};

export async function syncChildProfiles(
  parent: GatewayProfile,
  providers: GatewayManifestProvider[],
): Promise<ChildProfileSync> {
  const current = await loadGateways();
  const { toRemove } = reconcileChildProfiles(parent, providers, current);
  if (toRemove.length === 0) return { gateways: current, removedIds: [] };
  return { gateways: await removeGatewayIds(toRemove), removedIds: toRemove };
}

/**
 * A retire can take the profile the app is connected to: a legacy
 * `parentId::providerId` profile is a real, connectable gateway, and the sync
 * runs on every manifest read. The delete path reconciles its active
 * connection against what it dropped (`deleteGateway`); a caller replacing the
 * roster asks this the same way before it does — the active profile is gone
 * when its own id was retired, or when the parent it hangs off was (the delete
 * path's cascade removes children too).
 */
export function retirementTookActiveGateway(
  removedIds: readonly string[],
  active: Pick<GatewayProfile, 'id' | 'parentId'> | null,
): boolean {
  if (!active) return false;
  if (removedIds.includes(active.id)) return true;
  return active.parentId !== undefined && removedIds.includes(active.parentId);
}
