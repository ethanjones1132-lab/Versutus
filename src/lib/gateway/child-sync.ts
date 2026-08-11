// ─── Provider child-profile sync ─────────────────────────────────
// A gate can advertise multiple providers behind one manifest (spec §7).
// Each becomes its own GatewayProfile so the rest of the app (which only
// knows how to talk to "a gateway") needs no special case for "a gateway
// with children." Child ids are deterministic so re-syncing an unchanged
// manifest is a no-op, and so "every child of this parent" is answerable
// by id prefix alone — no separate index to keep in sync.

import type { GatewayManifestProvider } from '@/lib/portal/manifest';
import type { GatewayProfile } from '@/lib/gateway/types';

export function childProfileId(parentId: string, providerId: string): string {
  return `${parentId}::${providerId}`;
}

function childProfileFor(
  parent: GatewayProfile,
  provider: GatewayManifestProvider,
  existing: GatewayProfile | undefined,
): GatewayProfile {
  return {
    id: childProfileId(parent.id, provider.id),
    name: provider.label,
    url: `${parent.url.replace(/\/+$/, '')}${provider.basePath}`,
    kind: 'custom',
    token: parent.token,
    parentId: parent.id,
    createdAt: existing?.createdAt ?? Date.now(),
  };
}

function profilesEqual(a: GatewayProfile, b: GatewayProfile): boolean {
  return a.name === b.name && a.url === b.url && a.token === b.token && a.kind === b.kind;
}

/**
 * Pure reconciliation: given the parent, what it currently advertises, and
 * every gateway the app knows about, compute the child-profile diff. Never
 * touches a gateway belonging to a different parent.
 */
export function reconcileChildProfiles(
  parent: GatewayProfile,
  providers: GatewayManifestProvider[],
  allGateways: GatewayProfile[],
): { toUpsert: GatewayProfile[]; toRemove: string[] } {
  const prefix = `${parent.id}::`;
  const existingChildren = new Map(
    allGateways.filter((g) => g.parentId === parent.id && g.id.startsWith(prefix)).map((g) => [g.id, g]),
  );

  const toUpsert: GatewayProfile[] = [];
  const wanted = new Set<string>();

  for (const provider of providers) {
    const id = childProfileId(parent.id, provider.id);
    wanted.add(id);
    const existing = existingChildren.get(id);
    const next = childProfileFor(parent, provider, existing);
    if (!existing || !profilesEqual(existing, next)) toUpsert.push(next);
  }

  const toRemove = [...existingChildren.keys()].filter((id) => !wanted.has(id));

  return { toUpsert, toRemove };
}

/**
 * Applies reconcileChildProfiles against persisted storage and returns the
 * resulting full gateway list. Call after a successful connect or capability
 * refresh — see gateway-provider.tsx's attachClient.
 */
export async function syncChildProfiles(
  parent: GatewayProfile,
  providers: GatewayManifestProvider[],
): Promise<GatewayProfile[]> {
  // Dynamic import keeps pure reconcile free of native storage deps (so unit
  // tests of reconcileChildProfiles do not require AsyncStorage mocks).
  const { loadGateways, saveGateways } = await import('@/lib/gateway/storage');
  const current = await loadGateways();
  const { toUpsert, toRemove } = reconcileChildProfiles(parent, providers, current);
  if (toUpsert.length === 0 && toRemove.length === 0) return current;

  const removeSet = new Set(toRemove);
  const upsertMap = new Map(toUpsert.map((p) => [p.id, p]));
  const next = current
    .filter((g) => !removeSet.has(g.id))
    .map((g) => upsertMap.get(g.id) ?? g);
  for (const [id, profile] of upsertMap) {
    if (!next.some((g) => g.id === id)) next.push(profile);
  }

  await saveGateways(next);
  return next;
}
