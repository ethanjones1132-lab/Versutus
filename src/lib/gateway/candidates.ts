import { isPrivateOrLanHost, isTailnetHost, normalizeGatewayUrl } from '@/lib/gateway/url';

import type { DiscoveredGateway } from '@/lib/discovery/types';

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

/** Split host:port when the user types an explicit port (IPv4 / hostname only). */
function splitHostPort(input: string): { host: string; port?: string } {
  const match = /^([^:[\]]+):(\d{2,5})$/.exec(input);
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