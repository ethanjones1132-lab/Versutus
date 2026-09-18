const PRIVATE_IPV4 =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isPrivateOrLanHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  if (isLoopbackHost(normalized)) return true;
  if (normalized.endsWith('.local')) return true;
  return PRIVATE_IPV4.test(normalized);
}

export function isTailnetHost(host: string): boolean {
  return host.toLowerCase().replace(/\.$/, '').endsWith('.ts.net');
}

// A hostname whose dot-separated labels are all decimal numbers or `0x` hex
// literals is one the WHATWG URL parser will treat as an IPv4 address. A real
// hostname (letters in a label) never reaches the numeric branch — that split
// is shared with the onboarding validator's dotted-decimal-first check.
const NUMERIC_HOST_LABEL = /^(?:\d+|0x[0-9a-f]+)$/;
const CANONICAL_IPV4_OCTET = /^(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/;

export function isNumericHost(host: string): boolean {
  return host.toLowerCase().split('.').every(label => NUMERIC_HOST_LABEL.test(label));
}

export function isCanonicalIpv4(host: string): boolean {
  const labels = host.toLowerCase().split('.');
  return labels.length === 4 && labels.every(label => CANONICAL_IPV4_OCTET.test(label));
}

export function hasImpossibleNumericOctets(host: string): boolean {
  return isNumericHost(host) && !isCanonicalIpv4(host);
}

export function shouldUseTlsForHost(_host: string): boolean {
  // Hermes API server typically runs plain HTTP on LAN/tailnet.
  // TLS is handled by Tailscale Serve or a reverse proxy if needed.
  return false;
}

/**
 * Normalize a gateway URL to an HTTP base URL.
 * Hermes API server uses HTTP (not WebSocket), default port 8642.
 */
export function normalizeGatewayUrl(
  input: string,
  _options?: { preferTls?: boolean; tlsFingerprint?: string },
): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Gateway URL is required');

  // WebSocket-style entries (ws:// / wss://) identify fine but cannot be
  // fetched by the HTTP-side probes, and every consumer re-derives its ws://
  // from the http base via httpToWsBase anyway — so the canonical form is
  // always http(s), with any path dropped.
  const schemeMapped = trimmed.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  const hasScheme = /^https?:\/\//i.test(schemeMapped);
  const withScheme = hasScheme ? schemeMapped : `http://${schemeMapped}`;

  const invalid = (detail: string) =>
    new Error(
      `Invalid gateway URL: "${trimmed}" ${detail} — include host and port, e.g. http://yourpc.tailnet.ts.net:8760`,
    );

  // The WHATWG URL parser does not reject every impossible numeric host — it
  // silently reinterprets a bare integer (2130706433 => 127.0.0.1), a short
  // dotted-decimal (1.2.3 => 1.2.0.3), and octal/hex labels (0250.168.0.1 =>
  // 168.168.0.1). Judge the host text as typed, so the address probed and saved
  // is the one the operator wrote, or refuse the entry outright.
  const rawHost = withScheme.replace(/^https?:\/\//i, '').match(/^[^/?#:]*/)?.[0] ?? '';
  if (hasImpossibleNumericOctets(rawHost)) {
    throw invalid('names an impossible IP address');
  }

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw invalid('does not parse');
  }
  const host = parsed.hostname;
  if (!host) throw invalid('has no host');

  // Hermes listens on plain HTTP :8642. When a host is fronted by Tailscale
  // Serve or another TLS reverse proxy, HTTPS uses its standard :443 port.
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '8642');

  // Strip trailing slash
  return `${parsed.protocol}//${host}:${port}`;
}

/**
 * Convert an HTTP base URL to a WebSocket URL (for SSE fallback or future WebSocket features).
 */
export function httpToWsBase(httpUrl: string): string {
  const parsed = new URL(httpUrl);
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${parsed.host}`;
}

export function buildGatewayUrlFromBeacon(params: {
  host: string;
  port: number;
  txt?: Record<string, string>;
  preferTailnetDns?: boolean;
}): { url: string; tlsFingerprint?: string; displayName?: string } {
  const txt = params.txt ?? {};
  const tlsFingerprint = txt.gatewayTlsSha256?.trim() || undefined;
  const tailnetDns = txt.tailnetDns?.trim();
  const displayName = txt.displayName?.trim();

  let host = params.host.replace(/\.$/, '');
  const port = params.port || Number(txt.gatewayPort) || 8642;

  if (params.preferTailnetDns !== false && tailnetDns) {
    if (host.startsWith('100.') || isTailnetHost(host) || !isPrivateOrLanHost(host)) {
      host = tailnetDns.replace(/\.$/, '');
    }
  }

  const url = normalizeGatewayUrl(`http://${host}:${port}`);

  return { url, tlsFingerprint, displayName };
}