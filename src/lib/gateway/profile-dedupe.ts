// ─── One saved profile per gateway ────────────────────────────────────────
// Every add path — onboarding auto-connect, a discovery beacon, a manual or
// deep-link add — made a brand-new profile with a fresh id, and the store only
// ever matched on id. So the same Gate saved twice became two profiles. On
// 2026-09-16 "Gateway" and "Ethanspc" both pointed at the same URL, one with
// the token and one without, and which one the app connected to decided
// whether requests authenticated at all.
//
// Two rules, both pure:
// - collapse what is already saved: keep the profile that can authenticate,
//   fill its gaps from the duplicate, re-point children and the active id;
// - on add, merge into the saved profile instead of creating a second one.
//
// Only top-level profiles are ever merged. Provider child profiles
// (`parentId`) are materialised from their parent and follow it.

import type { GatewayProfile } from '@/lib/gateway/types';

/** Scalar fields the kept profile may inherit when it has none of its own. */
const FILLABLE: readonly (keyof GatewayProfile)[] = [
  'token',
  'kind',
  'tlsFingerprint',
  'tlsFingerprintTrusted',
  'tlsFingerprintFirstSeenAt',
  'sessionKey',
  'sessionId',
  'agentId',
  'backendId',
  'model',
];

/**
 * The identity two profiles share when they are the same gateway: scheme,
 * host (case-insensitive), port and path, ignoring a trailing slash. Unlike
 * `normalizeGatewayUrl` this keeps the path, so two gateways behind one host
 * are never mistaken for one.
 */
export function gatewayIdentityKey(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** The kept profile, with every gap filled from `others` in order. */
function fillFrom(kept: GatewayProfile, others: readonly GatewayProfile[]): GatewayProfile {
  const merged: GatewayProfile = { ...kept };
  const writable = merged as Record<string, unknown>;
  for (const field of FILLABLE) {
    if (!isEmpty(merged[field])) continue;
    const donor = others.find((other) => !isEmpty(other[field]));
    if (donor) writable[field] = donor[field];
  }
  // Per-Bot and per-backend pins: the kept profile's own picks win, the
  // duplicates only fill Bots and backends it never pinned.
  for (const mapField of ['botModels', 'backendModels'] as const) {
    const combined = Object.assign({}, ...others.map((other) => other[mapField] ?? {}).reverse(), kept[mapField] ?? {});
    if (Object.keys(combined).length > 0) merged[mapField] = combined;
  }
  return merged;
}

export type CollapsedGateways = {
  gateways: GatewayProfile[];
  /** Removed profile id → the id it was merged into. */
  idMap: Record<string, string>;
  /** The active id after remapping (unchanged when it survived). */
  activeId: string | null;
  changed: boolean;
};

/**
 * Collapse saved top-level profiles that point at the same gateway.
 *
 * Kept per group: the active profile if it has a token, else the first with a
 * token, else the active one, else the first. A profile that can authenticate
 * is the one worth keeping; the active one breaks ties.
 */
export function collapseDuplicateGateways(
  gateways: readonly GatewayProfile[],
  activeId: string | null | undefined,
): CollapsedGateways {
  const groups = new Map<string, GatewayProfile[]>();
  for (const gateway of gateways) {
    if (gateway.parentId) continue;
    const key = gatewayIdentityKey(gateway.url);
    const group = groups.get(key);
    if (group) group.push(gateway);
    else groups.set(key, [gateway]);
  }

  const idMap: Record<string, string> = {};
  const replacement = new Map<string, GatewayProfile>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const active = group.find((gateway) => gateway.id === activeId);
    const kept =
      (active && !isEmpty(active.token) ? active : undefined) ??
      group.find((gateway) => !isEmpty(gateway.token)) ??
      active ??
      group[0];
    const others = group.filter((gateway) => gateway !== kept);
    replacement.set(kept.id, fillFrom(kept, others));
    for (const other of others) idMap[other.id] = kept.id;
  }

  if (Object.keys(idMap).length === 0) {
    return { gateways: [...gateways], idMap, activeId: activeId ?? null, changed: false };
  }

  const collapsed: GatewayProfile[] = [];
  for (const gateway of gateways) {
    if (idMap[gateway.id]) continue;
    const merged = replacement.get(gateway.id) ?? gateway;
    const parent = merged.parentId ? idMap[merged.parentId] : undefined;
    collapsed.push(parent ? { ...merged, parentId: parent } : merged);
  }
  const nextActive = activeId ? (idMap[activeId] ?? activeId) : null;
  return { gateways: collapsed, idMap, activeId: nextActive, changed: true };
}

/**
 * Add `incoming` to the saved list, merging it into a saved top-level profile
 * for the same gateway when there is one.
 *
 * The saved profile keeps its id, name and pins; the incoming profile's
 * non-empty connection facts win, so a freshly entered or granted token
 * replaces a stale one — and an incoming profile with no token never erases a
 * saved one.
 */
export function mergeIntoExistingGateway(
  gateways: readonly GatewayProfile[],
  incoming: GatewayProfile,
): { profile: GatewayProfile; gateways: GatewayProfile[] } {
  if (incoming.parentId) {
    return { profile: incoming, gateways: upsertById(gateways, incoming) };
  }
  const key = gatewayIdentityKey(incoming.url);
  const saved = gateways.find(
    (gateway) => !gateway.parentId && gateway.id !== incoming.id && gatewayIdentityKey(gateway.url) === key,
  );
  if (!saved) return { profile: incoming, gateways: upsertById(gateways, incoming) };

  const merged: GatewayProfile = { ...saved };
  const writable = merged as Record<string, unknown>;
  for (const field of FILLABLE) {
    if (!isEmpty(incoming[field])) writable[field] = incoming[field];
  }
  if (isEmpty(saved.name) && !isEmpty(incoming.name)) merged.name = incoming.name;
  return {
    profile: merged,
    gateways: gateways.map((gateway) => (gateway.id === saved.id ? merged : gateway)),
  };
}

function upsertById(gateways: readonly GatewayProfile[], profile: GatewayProfile): GatewayProfile[] {
  const index = gateways.findIndex((gateway) => gateway.id === profile.id);
  if (index < 0) return [profile, ...gateways];
  return gateways.map((gateway, i) => (i === index ? profile : gateway));
}
