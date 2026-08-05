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

  const hasScheme = /^https?:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  const host = parsed.hostname;

  const port = parsed.port || '8642';

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