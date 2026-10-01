/**
 * The manifest a connect should build its client from.
 *
 * A Gate is only reachable as a Gate through its manifest: the manifest's
 * routes are what make the client a ManifestClient. Without one, the client
 * factory hands a Gate profile the Hermes adapter, which answers chat and
 * `/v1` reads well enough to look connected while every Gate-only RPC
 * (`providers.list`, `notifications.preferences.get`, …) fails on the phone
 * with "not supported by this gateway". A phone whose tailnet was idle a
 * moment before misses the first manifest fetch often enough that this was
 * the Gate setup screen's usual state.
 *
 * So a profile already known to be a Gate is built from the last manifest it
 * served — a Gate's routes do not change between launches — rather than the
 * wrong client, and the live document is asked for alongside the connect
 * instead of in front of it. Pure over injected reads, so it is tested without
 * a network.
 */

import { keyValueStorage } from '@/lib/storage/key-value';

import { isGatewayManifest, type GatewayManifest } from './manifest';

export type AttachManifestSource = 'live' | 'cached' | 'none';

export type AttachManifest = {
  manifest: GatewayManifest | null;
  source: AttachManifestSource;
};

/** How long a known Gate is given before its manifest is asked for again. */
export const GATE_MANIFEST_RETRY_MS = 900;

export async function manifestForAttach({
  knownGate,
  fetchLive,
  loadCached,
  saveCached,
  retryDelayMs = GATE_MANIFEST_RETRY_MS,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  onLive,
}: {
  /** The profile was saved as a Gate (kind 'custom'): a missing manifest is a miss, not an answer. */
  knownGate: boolean;
  fetchLive: () => Promise<GatewayManifest | null>;
  loadCached: () => Promise<GatewayManifest | null>;
  saveCached: (manifest: GatewayManifest) => Promise<void>;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The live manifest the background refresh served, when one was cached. The
   * caller owns everything a later manifest changes (the active manifest, the
   * child-profile roster), so handing it over is what keeps the attach from
   * fetching the same document a second time.
   */
  onLive?: (manifest: GatewayManifest) => void;
}): Promise<AttachManifest> {
  if (knownGate) {
    // A usable manifest is already on disk, so the connect starts now and the
    // live refresh runs beside it. Asking first meant a known Gate that was down
    // or slow could not begin connecting for ~21s (live, 0.9s, live again)
    // although the document that makes it a Gate was sitting in storage.
    const cached = await loadCached().catch(() => null);
    if (cached) {
      void fetchLive()
        .then((live) => {
          if (!live) return undefined;
          // A refused write still leaves the caller its fresh manifest.
          return saveCached(live)
            .catch(() => undefined)
            .then(() => onLive?.(live));
        })
        .catch(() => undefined);
      return { manifest: cached, source: 'cached' };
    }
  }
  let live = await fetchLive().catch(() => null);
  if (!live && knownGate) {
    await sleep(retryDelayMs);
    live = await fetchLive().catch(() => null);
  }
  if (live) {
    await saveCached(live).catch(() => undefined);
    return { manifest: live, source: 'live' };
  }
  return { manifest: null, source: 'none' };
}

/**
 * Whether a manifest that arrived after connect must rebuild the client. A
 * connect that had no manifest built the Hermes adapter; a Gate that now
 * answers deserves its own client. One built from a cached manifest already
 * is that client, so it is left alone.
 */
export function lateManifestUpgradesClient(attachSource: AttachManifestSource, late: GatewayManifest | null): boolean {
  return attachSource === 'none' && late !== null;
}

// ─── The last manifest each Gate served, on this device ──────────────

const CACHE_PREFIX = 'versutus:gate-manifest:';

export function gateManifestCacheKey(gatewayId: string): string {
  return `${CACHE_PREFIX}${gatewayId}`;
}

export async function loadCachedGateManifest(gatewayId: string): Promise<GatewayManifest | null> {
  const raw = await keyValueStorage.getItem(gateManifestCacheKey(gatewayId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isGatewayManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveCachedGateManifest(gatewayId: string, manifest: GatewayManifest): Promise<void> {
  await keyValueStorage.setItem(gateManifestCacheKey(gatewayId), JSON.stringify(manifest));
}

/**
 * `transport.ipv4` out of each saved top-level profile's last cached manifest,
 * keyed by profile id: the evidence that a host which just answered a probe is
 * the one that profile was talking to under its MagicDNS name. Child profiles
 * are skipped — they share the parent's cache and answer on their parent's URL.
 */
export async function cachedManifestIpv4ByProfileId(
  gateways: readonly { id: string; parentId?: string }[],
): Promise<Record<string, string[] | undefined>> {
  const entries = await Promise.all(
    gateways
      .filter((gateway) => !gateway.parentId)
      .map(async (gateway) => {
        const manifest = await loadCachedGateManifest(gateway.id).catch(() => null);
        return [gateway.id, manifest?.transport?.ipv4 ?? []] as const;
      }),
  );
  return Object.fromEntries(entries);
}
