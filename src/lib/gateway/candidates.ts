import { collapseDuplicateGateways, gatewayIdentityKey } from '@/lib/gateway/profile-dedupe';
import { isPrivateOrLanHost, isTailnetHost, normalizeGatewayUrl } from '@/lib/gateway/url';

import type { CollapsedGateways } from '@/lib/gateway/profile-dedupe';
import type { DiscoveredGateway } from '@/lib/discovery/types';
import type { GatewayProfile } from '@/lib/gateway/types';

export function normalizePcAddress(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, '');
}

export function friendlyPcName(input: string): string {
  const normalized = normalizePcAddress(input);
  if (!normalized) return 'My PC';
  const short = normalized.split('.')[0];
  return short.charAt(0).toUpperCase() + short.slice(1);
}

const HERMES_PORT = 8642;
/** Versutus Gate default listen port (gate/cli.mjs start). */
const GATE_PORT = 8760;

export function buildGatewayCandidates(options: {
  tailscaleHost?: string;
  configuredHosts?: string[];
  savedUrls?: string[];
  discovered?: DiscoveredGateway[];
  lastSuccessfulUrl?: string;
  platform?: string;
  includeLocalFallbacks?: boolean;
}): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  const push = (raw: string) => {
    try {
      const normalized = normalizeGatewayUrl(raw);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      urls.push(normalized);
    } catch {
      // skip invalid
    }
  };

  // The host the user just typed must win over a sticky lastSuccessfulUrl.
  // Otherwise a prior Hermes hit on :8642 permanently shadows Gate on :8760.
  const host = options.tailscaleHost ? normalizePcAddress(options.tailscaleHost) : '';
  if (host) pushHostCandidates(host);

  if (options.lastSuccessfulUrl) push(options.lastSuccessfulUrl);

  for (const gateway of options.discovered ?? []) {
    push(gateway.url);
  }

  for (const configuredHost of options.configuredHosts ?? []) {
    pushHostCandidates(configuredHost);
  }

  for (const saved of options.savedUrls ?? []) {
    push(saved);
  }

  if (options.includeLocalFallbacks !== false) {
    for (const fallbackHost of localFallbackHosts(options.platform)) {
      push(`http://${fallbackHost}:${GATE_PORT}`);
      push(`http://${fallbackHost}:${HERMES_PORT}`);
    }
  }

  return urls;

  function pushHostCandidates(rawHost: string) {
    const candidateHost = normalizePcAddress(rawHost);
    if (!candidateHost) return;

    // Allow "host:port" so onboarding can target Gate :8760 explicitly.
    const explicit = splitHostPort(candidateHost);
    if (explicit.port) {
      push(`http://${explicit.host}:${explicit.port}`);
      return;
    }

    if (isTailscaleIp(candidateHost)) {
      // A tailnet IP is the DNS-free route: it still rides the encrypted
      // WireGuard tunnel, and it is the only candidate that works when a device
      // has not accepted Tailscale DNS. No HTTPS variant — Serve's certificate
      // is issued for the hostname, so TLS to a bare IP can never validate.
      // Prefer Gate (:8760), then Hermes (:8642).
      push(`http://${candidateHost}:${GATE_PORT}`);
      push(`http://${candidateHost}:${HERMES_PORT}`);
      return;
    }

    if (isTailnetHost(candidateHost)) {
      // Tailscale Serve terminates TLS on the host's standard HTTPS port and
      // proxies to Hermes' plain HTTP listener on :8642. Do not send TLS to
      // :8642; that is the backend listener, not the Serve endpoint.
      push(`https://${candidateHost}`);
      push(`http://${candidateHost}:${GATE_PORT}`);
      push(`http://${candidateHost}:${HERMES_PORT}`);
      return;
    }

    if (isPrivateOrLanHost(candidateHost)) {
      push(`http://${candidateHost}:${GATE_PORT}`);
      push(`http://${candidateHost}:${HERMES_PORT}`);
      return;
    }

    if (candidateHost.includes('.')) {
      // Public/tailnet DNS names may be fronted by a TLS reverse proxy on
      // :443; the direct Gate/Hermes listeners remain plain HTTP.
      push(`https://${candidateHost}`);
      push(`http://${candidateHost}:${GATE_PORT}`);
      push(`http://${candidateHost}:${HERMES_PORT}`);
    }
  }
}

/**
 * The URLs for exactly the host the user just typed — nothing discovered,
 * saved, or fallen back to. The add-gateway flow probes these while the
 * discovery window runs instead of after it, so a correct address answers
 * without paying the fixed wait first. Everything else is folded in later
 * through `buildGatewayCandidates` when the explicit host does not answer.
 */
export function buildExplicitHostCandidates(tailscaleHost: string): string[] {
  return buildGatewayCandidates({ tailscaleHost, includeLocalFallbacks: false });
}

/**
 * The beacon TXT kind for a URL `resolveGatewayForUrl` is about to identify,
 * so the call can hand it to `identifyGateway` as `beaconKind` instead of
 * re-fingerprinting a gateway whose kind discovery already advertised. Blank
 * or absent kinds resolve to undefined, and `identifyGateway` then runs its
 * full cascade exactly as it does today.
 */
export function beaconKindForUrl(
  discovered: Pick<DiscoveredGateway, 'url' | 'kind'>[],
  url: string,
): string | undefined {
  const kind = discovered.find((item) => item.url === url)?.kind?.trim();
  return kind ? kind : undefined;
}

/** Host, effective port and base path of a gateway URL, or null when it is not one. */
type GatewayEndpoint = { host: string; port: string; path: string };

function endpointOf(url: string): GatewayEndpoint | null {
  try {
    const parsed = new URL(url.trim());
    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
      path: parsed.pathname.replace(/\/+$/, ''),
    };
  } catch {
    return null;
  }
}

function listsHost(hosts: readonly string[] | undefined, host: string): boolean {
  return (hosts ?? []).some((entry) => normalizePcAddress(entry) === host);
}

export type SavedGatewayMatchOptions = {
  /** The address the operator configured, as `appSettings.tailscaleHost` holds it. */
  tailscaleHost?: string;
  /** `transport.ipv4` of each saved profile's last cached manifest, by profile id. */
  cachedIpv4ByProfileId?: Record<string, readonly string[] | undefined>;
  /** The profile id this device last connected to. */
  activeId?: string | null;
};

/**
 * The saved profile a probe winner belongs to, or undefined for a gateway that
 * is genuinely new.
 *
 * A wave winner matched a saved profile by exact URL only, so one Gate reached
 * under a second host form — the MagicDNS name while the tailnet IP answers, or
 * a LAN address for the same PC — became a brand-new profile with no token. Its
 * connect fan-out then went out unauthenticated, and the Gate's 401 read as
 * "the key was refused" (AUTH-1).
 *
 * Same Gate when any of: the same identity key (scheme + host + port + path);
 * the winner's host is one this profile's alternate IPv4s or its last cached
 * manifest advertised; or the winner is the configured `tailscaleHost` and the
 * profile is the active (or only) Gate profile. The port always has to match —
 * a second listener on one host (Gate :8760, Hermes :8642) is a different
 * service, and borrowing the Gate's token for it would earn the very refusal
 * this exists to prevent. Child profiles are skipped: they are materialised
 * under their parent and follow it.
 */
export function matchSavedGateway(
  url: string,
  saved: readonly GatewayProfile[],
  options: SavedGatewayMatchOptions = {},
): GatewayProfile | undefined {
  return savedGatewayMatches(url, saved, options)[0]?.profile;
}

/**
 * The address a wave winner adds to a saved profile's alternate IPv4s: the host
 * it answered on, when the profile does not already name it and the port still
 * matches (a second listener on one host is a different service). Empty when
 * there is nothing new to remember, so the caller can leave storage alone.
 *
 * This — not a rewritten URL — is how a wave reaches a Gate this device is
 * paired with while its MagicDNS name is in a blip: the saved URL stays the
 * operator's, and every request falls back to the advertised address (the same
 * mechanism a Gate's own manifest uses), instead of the roster learning an
 * address that one lucky wave happened to win on.
 */
export function reachableAlternateIpv4(
  winnerUrl: string,
  saved: Pick<GatewayProfile, 'url' | 'alternateIpv4'>,
): string[] {
  const winner = endpointOf(winnerUrl);
  const profile = endpointOf(saved.url);
  if (!winner || !profile || winner.host === profile.host || winner.port !== profile.port) return [];
  const known = saved.alternateIpv4 ?? [];
  return listsHost(known, winner.host) ? [] : [...known, winner.host];
}

/** Every saved profile this winner could be, best first. */
function savedGatewayMatches(
  url: string,
  saved: readonly GatewayProfile[],
  options: SavedGatewayMatchOptions = {},
): { profile: GatewayProfile; rank: number }[] {
  const winner = endpointOf(url);
  if (!winner) return [];
  const configuredHost = options.tailscaleHost ? normalizePcAddress(options.tailscaleHost) : '';
  // The Gate profiles that could be this address's Gate, which is what the
  // configured-host rule below counts. A profile that carries no key is not one
  // of them: it cannot be the Gateway this device is paired with, and the
  // token-less copy a bad wave saved would otherwise block the very match that
  // heals it.
  const gateProfilesOnPort = saved.filter(
    (profile) =>
      !profile.parentId &&
      profile.kind === 'custom' &&
      Boolean(profile.token) &&
      endpointOf(profile.url)?.port === winner.port,
  );

  const rank = (profile: GatewayProfile): number => {
    if (gatewayIdentityKey(profile.url) === gatewayIdentityKey(url)) return 0;
    const endpoint = endpointOf(profile.url);
    if (!endpoint || endpoint.port !== winner.port) return -1;
    // A profile below a base path is a provider child; a winner that carries one
    // is that child, not the Gate's own listener.
    if (endpoint.path !== '' || winner.path !== '') return -1;
    // The winner's host is an address this profile already knows as its own —
    // the one it was last reached on, or one the Gate advertised for itself.
    if (
      listsHost(profile.alternateIpv4, winner.host) ||
      listsHost(options.cachedIpv4ByProfileId?.[profile.id], winner.host)
    ) {
      return 1;
    }
    // The winner is the configured address, and this is the only Gate profile
    // that can hold it.
    if (
      configuredHost &&
      winner.host === configuredHost &&
      profile.kind === 'custom' &&
      (profile.id === options.activeId ||
        gateProfilesOnPort.every((gate) => gate.id === profile.id))
    ) {
      return 2;
    }
    return -1;
  };

  const matches = saved
    .filter((profile) => !profile.parentId)
    .map((profile) => ({ profile, rank: rank(profile) }))
    .filter((entry) => entry.rank >= 0)
    // A profile that can authenticate is the one worth reconnecting, so it wins
    // over a token-less twin whatever else it matched on; the profile this
    // device last used breaks the remaining ties.
    .sort((a, b) => {
      const token = Number(Boolean(b.profile.token)) - Number(Boolean(a.profile.token));
      if (token !== 0) return token;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return Number(b.profile.id === options.activeId) - Number(a.profile.id === options.activeId);
    });
  return matches;
}

/**
 * Fold the token-less twins of a Gate into the saved profile that can
 * authenticate, the way a probe winner now resolves to it.
 *
 * A phone that ran the fan-out bug for days already holds one: a Gate saved
 * twice, the paired copy under its MagicDNS name and a second copy created
 * without a token under the tailnet IP one wave happened to win on — often the
 * ACTIVE one, since that is the copy the connect picked. Left alone it keeps
 * winning every wave, so the roster heals it once at startup instead.
 *
 * Same Gate by the rule above, and only when exactly one saved profile can
 * authenticate for it — a second claimant makes the merge a guess, and a guess
 * that drops a profile takes a reachable gateway with it. The surviving profile
 * keeps its own id, URL, token and pins; the twin only fills its gaps, exactly
 * as collapsing two exact duplicates does.
 */
export function mergeTokenlessTwinGateways(
  gateways: readonly GatewayProfile[],
  activeId: string | null | undefined,
  options: SavedGatewayMatchOptions = {},
): CollapsedGateways {
  const survivorUrlByTwin = new Map<string, string>();
  for (const twin of gateways) {
    if (twin.parentId || twin.token) continue;
    const claimants = savedGatewayMatches(twin.url, gateways, options)
      .map((match) => match.profile)
      .filter((profile) => profile.id !== twin.id && profile.token);
    if (claimants.length !== 1) continue;
    survivorUrlByTwin.set(twin.id, claimants[0].url);
  }
  if (survivorUrlByTwin.size === 0) {
    return { gateways: [...gateways], idMap: {}, activeId: activeId ?? null, changed: false };
  }
  // The twin is rewritten onto the survivor's URL so the existing collapse does
  // the merging — and its filling — by the rule it already applies to two saved
  // copies of one gateway.
  return collapseDuplicateGateways(
    gateways.map((gateway) => {
      const survivorUrl = survivorUrlByTwin.get(gateway.id);
      return survivorUrl ? { ...gateway, url: survivorUrl } : gateway;
    }),
    activeId,
  );
}

/**
 * Split host:port when the user types an explicit port (IPv4 / hostname only).
 *
 * The width matches what `validatePcAddress` accepts, so an address the
 * onboarding field called ready can always form a candidate. A port outside
 * 1-65535 is refused there; one that reaches here from an already-saved
 * setting cannot be normalized (`new URL` throws) and is dropped by `push`'s
 * catch, leaving the rest of the wave to answer as it always has.
 */
function splitHostPort(input: string): { host: string; port?: string } {
  const match = /^([^:[\]]+):(\d{1,5})$/.exec(input);
  if (!match) return { host: input };
  return { host: match[1], port: match[2] };
}

function isTailscaleIp(host: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host);
}

function localFallbackHosts(platform?: string): string[] {
  if (platform === 'android') return ['10.0.2.2', '10.0.3.2', '127.0.0.1'];
  if (platform === 'ios' || platform === 'web') return ['127.0.0.1', 'localhost'];
  return ['127.0.0.1'];
}