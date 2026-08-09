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

  const host = options.tailscaleHost ? normalizePcAddress(options.tailscaleHost) : '';
  if (host) pushHostCandidates(host);

  if (options.includeLocalFallbacks !== false) {
    for (const fallbackHost of localFallbackHosts(options.platform)) {
      push(`http://${fallbackHost}:${HERMES_PORT}`);
    }
  }

  return urls;

  function pushHostCandidates(rawHost: string) {
    const candidateHost = normalizePcAddress(rawHost);
    if (!candidateHost) return;

    if (isTailnetHost(candidateHost) || isTailscaleIp(candidateHost)) {
      // Tailscale Serve terminates TLS on the host's standard HTTPS port and
      // proxies to Hermes' plain HTTP listener on :8642. Do not send TLS to
      // :8642; that is the backend listener, not the Serve endpoint.
      push(`https://${candidateHost}`);
      push(`http://${candidateHost}:${HERMES_PORT}`);
      return;
    }

    if (isPrivateOrLanHost(candidateHost)) {
      push(`http://${candidateHost}:${HERMES_PORT}`);
      return;
    }

    if (candidateHost.includes('.')) {
      // Public/tailnet DNS names may be fronted by a TLS reverse proxy on
      // :443; the direct Hermes fallback remains plain HTTP on :8642.
      push(`https://${candidateHost}`);
      push(`http://${candidateHost}:${HERMES_PORT}`);
    }
  }
}

function isTailscaleIp(host: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host);
}

function localFallbackHosts(platform?: string): string[] {
  if (platform === 'android') return ['10.0.2.2', '10.0.3.2', '127.0.0.1'];
  if (platform === 'ios' || platform === 'web') return ['127.0.0.1', 'localhost'];
  return ['127.0.0.1'];
}