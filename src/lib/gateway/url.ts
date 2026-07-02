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

export function shouldUseTlsForHost(host: string, gatewayTls?: boolean): boolean {
  if (gatewayTls) return true;
  if (isTailnetHost(host)) return true;
  if (isPrivateOrLanHost(host)) return false;
  return true;
}

export function wsToHttpBase(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const port = parsed.port || (parsed.protocol === 'wss:' ? '443' : '18789');
  return `${protocol}//${parsed.hostname}:${port}`;
}

export function normalizeGatewayUrl(
  input: string,
  options?: { preferTls?: boolean; tlsFingerprint?: string },
): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Gateway URL is required');

  const explicitWss = /^wss:\/\//i.test(trimmed) || /^https:\/\//i.test(trimmed);
  const explicitWs = /^ws:\/\//i.test(trimmed) || /^http:\/\//i.test(trimmed);
  const withScheme = explicitWss || explicitWs ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  const host = parsed.hostname;

  let useTls = explicitWss || Boolean(options?.preferTls) || isTailnetHost(host);
  if (explicitWs && isPrivateOrLanHost(host) && !options?.preferTls) {
    useTls = false;
  }
  if (!explicitWss && !explicitWs && shouldUseTlsForHost(host)) {
    useTls = true;
  }

  const protocol = useTls ? 'wss:' : 'ws:';
  const port = parsed.port || (useTls ? '443' : '18789');

  void options?.tlsFingerprint;
  return `${protocol}//${host}:${port}`;
}

export function buildGatewayUrlFromBeacon(params: {
  host: string;
  port: number;
  txt?: Record<string, string>;
  preferTailnetDns?: boolean;
}): { url: string; tlsFingerprint?: string; displayName?: string } {
  const txt = params.txt ?? {};
  const gatewayTls = txt.gatewayTls === '1';
  const tlsFingerprint = txt.gatewayTlsSha256?.trim() || undefined;
  const tailnetDns = txt.tailnetDns?.trim();
  const displayName = txt.displayName?.trim();

  let host = params.host.replace(/\.$/, '');
  const port = params.port || Number(txt.gatewayPort) || 18789;

  if (params.preferTailnetDns !== false && tailnetDns) {
    if (host.startsWith('100.') || isTailnetHost(host) || !isPrivateOrLanHost(host)) {
      host = tailnetDns.replace(/\.$/, '');
    }
  }

  const useTls = shouldUseTlsForHost(host, gatewayTls);
  const url = normalizeGatewayUrl(`${useTls ? 'wss' : 'ws'}://${host}:${port}`, {
    preferTls: useTls,
    tlsFingerprint,
  });

  return { url, tlsFingerprint, displayName };
}