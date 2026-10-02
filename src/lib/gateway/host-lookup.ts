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

// A hostname whose lookup failed is remembered for two minutes: MagicDNS
// blips are transient, and re-resolving a broken name on EVERY request stalls
// each one for the resolver's timeout before the advertised IPv4 that already
// proved itself gets a turn. A hostname success clears the mark.
const HOST_LOOKUP_FAILURE_MEMORY_MS = 2 * 60 * 1000;
const hostLookupFailures = new Map<string, { failedAt: number }>();

/** Test escape hatch back to the pristine, nothing-remembered state. */
export function resetHostLookupMemoryForTests(): void {
  hostLookupFailures.clear();
}

/** Test escape hatch: how many hostnames are remembered as broken right now. */
export function hostLookupFailureCountForTests(): number {
  return hostLookupFailures.size;
}

/**
 * Remember a hostname lookup miss, sweeping marks that have already expired.
 * A host nobody probes any more (a deleted gateway, a rotating beacon host)
 * would otherwise keep its entry for the life of the process.
 */
function rememberHostLookupFailure(hostname: string): void {
  const now = Date.now();
  for (const [key, mark] of hostLookupFailures) {
    if (now - mark.failedAt >= HOST_LOOKUP_FAILURE_MEMORY_MS) hostLookupFailures.delete(key);
  }
  hostLookupFailures.set(hostname, { failedAt: now });
}

/**
 * True when a failure carries an HTTP status: the gateway answered on that
 * address, even to refuse. Such a rejection is not a transport fault, and the
 * same request against the hostname would only be refused the same way.
 */
function isHttpRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return typeof (error as { status?: unknown }).status === 'number';
}

/**
 * Try `url`, then each advertised IPv4 rewrite, only when the failure is a
 * host lookup miss. https is never rewritten (rewriteHttpUrlHost returns null).
 * Exhausted lookup misses become HostLookupError, not the raw Java exception.
 *
 * After a hostname lookup failure the advertised IPv4 candidates are tried
 * FIRST and the hostname last, for two minutes; a hostname success clears the
 * mark. An IPv4 that could not be reached at all (refused, unroutable, timed
 * out) does not strand that reordered pass: the hostname is still tried, and
 * only the last error surfaces if nothing answers.
 */
export async function withHostLookupRetry<T>(
  url: string,
  alternateIpv4: string[],
  attempt: (candidateUrl: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const hostname = hostnameOf(url);
  const ipv4Candidates: string[] = [];
  for (const ip of alternateIpv4) {
    const rewritten = rewriteHttpUrlHost(url, ip);
    if (rewritten) ipv4Candidates.push(rewritten);
  }
  const failed = hostLookupFailures.get(hostname);
  const rememberFailure =
    failed !== undefined && Date.now() - failed.failedAt < HOST_LOOKUP_FAILURE_MEMORY_MS;
  const candidates = rememberFailure ? [...ipv4Candidates, url] : [url, ...ipv4Candidates];
  // True only in the reordered pass, where the hostname is still untried and a
  // failed IPv4 therefore still owes the name a turn.
  const hostnameStillToCome = rememberFailure && ipv4Candidates.length > 0;
  let lastError: unknown;
  for (const candidate of candidates) {
    // A caller that has superseded this read does not owe any remaining
    // candidate a request.
    if (signal?.aborted) throw new Error('Host lookup retry aborted');
    try {
      const result = await attempt(candidate);
      if (candidate === url) hostLookupFailures.delete(hostname);
      return result;
    } catch (error) {
      if (signal?.aborted) throw new Error('Host lookup retry aborted');
      if (isHostLookupFailure(error)) {
        if (candidate === url) rememberHostLookupFailure(hostname);
        continue;
      }
      // A non-lookup failure is final once the hostname has had its turn: DNS
      // worked, so the error is the answer. It is also final when the gateway
      // itself answered (a 401 carries a status) — retrying the same request
      // against the hostname would only be refused the same way. Otherwise the
      // failure is about the address rather than the name, and in the reordered
      // pass the hostname still owes a turn: keep going, and throw the last
      // error if nothing answers.
      if (candidate === url || !hostnameStillToCome || isHttpRejection(error)) throw error;
      lastError = error;
    }
  }
  if (lastError !== undefined) throw lastError;
  throw new HostLookupError(hostname);
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
