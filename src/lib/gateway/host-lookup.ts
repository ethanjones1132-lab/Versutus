// ─── DNS blips on the phone ───────────────────────────────────────────────
// MagicDNS can fail for a moment while the tailnet IPv4 still works. The Gate
// advertises that IPv4 on the manifest; this module decides when a failure is
// a lookup miss, how to retry over http without touching https, and the words
// the operator sees instead of a Java UnknownHostException.

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export class HostLookupError extends Error {
  constructor(readonly hostname: string) {
    super(`The phone could not look up your PC's address (${hostname}).`);
    this.name = 'HostLookupError';
  }
}

export function isIpv4(value: string): boolean {
  if (!IPV4.test(value)) return false;
  return value.split('.').every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255 && String(n) === octet;
  });
}

const HOST_LOOKUP_SIGNAL =
  /UnknownHostException|Unable to resolve host|ENOTFOUND|getaddrinfo|NameNotResolved/i;

// Node wraps a fetch DNS miss as `TypeError: fetch failed` with the real
// signal hanging off `cause` (an Error whose message reads "getaddrinfo
// ENOTFOUND …" or a plain object with code ENOTFOUND). Walk that chain,
// bounded: nothing in the platform wraps deeper than the object itself.
export function isHostLookupFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const node = current as { message?: unknown; code?: unknown; cause?: unknown };
    const message = typeof node.message === 'string' ? node.message : String(current);
    if (HOST_LOOKUP_SIGNAL.test(message)) return true;
    if (node.code === 'ENOTFOUND') return true;
    current = node.cause;
  }
  return false;
}

/**
 * Rewrite an http URL onto an advertised IPv4, keeping path and query.
 * Returns null for https (TLS hostname checks must keep the original host)
 * and for a URL that is already that IP.
 */
export function rewriteHttpUrlHost(url: string, ipv4: string): string | null {
  if (!isIpv4(ipv4)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (parsed.hostname === ipv4) return null;
  parsed.hostname = ipv4;
  return parsed.href;
}

/**
 * Rewrite an http base URL onto an advertised IPv4. Returns null for https
 * (TLS hostname checks must keep the original host) and for a base that is
 * already that IP.
 */
export function rewriteHttpBaseHost(baseUrl: string, ipv4: string): string | null {
  const rewritten = rewriteHttpUrlHost(baseUrl, ipv4);
  if (!rewritten) return null;
  return new URL(rewritten).origin;
}

/**
 * Try `url`, then each advertised IPv4 rewrite, only when the failure is a
 * host lookup miss. https is never rewritten (rewriteHttpUrlHost returns null).
 * Exhausted lookup misses become HostLookupError, not the raw Java exception.
 */
export async function withHostLookupRetry<T>(
  url: string,
  alternateIpv4: string[],
  attempt: (candidateUrl: string) => Promise<T>,
): Promise<T> {
  const candidates = [url];
  for (const ip of alternateIpv4) {
    const rewritten = rewriteHttpUrlHost(url, ip);
    if (rewritten) candidates.push(rewritten);
  }
  for (const candidate of candidates) {
    try {
      return await attempt(candidate);
    } catch (error) {
      if (!isHostLookupFailure(error)) throw error;
    }
  }
  throw new HostLookupError(hostnameOf(url));
}

export function advertisedIpv4(input: {
  advertised?: unknown;
  configuredHosts?: string[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    const host = trimmed.includes('://')
      ? (() => {
          try {
            return new URL(trimmed).hostname;
          } catch {
            return trimmed;
          }
        })()
      : trimmed.split(':')[0] ?? trimmed;
    if (!isIpv4(host) || seen.has(host)) return;
    seen.add(host);
    out.push(host);
  };
  if (Array.isArray(input.advertised)) {
    for (const value of input.advertised) push(value);
  }
  for (const host of input.configuredHosts ?? []) push(host);
  return out;
}

export function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

export function ipv4FromExpoExtra(extra: unknown): string[] {
  if (!extra || typeof extra !== 'object') return [];
  const record = extra as { gatewayHosts?: unknown; openClawGatewayHosts?: unknown };
  const hosts = record.gatewayHosts ?? record.openClawGatewayHosts;
  if (!Array.isArray(hosts)) return [];
  return advertisedIpv4({ configuredHosts: hosts.map((host) => String(host)) });
}
