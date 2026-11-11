// ─── Gate media WebSocket URL ─────────────────────────────────────────────
// The phone opens `/v1/voice/stream` on the same host it already talks HTTP
// to. Native code then appends `voiceSessionId`. This fold is the only place
// the scheme is rewritten, so https cannot silently become ws.
//
// The socket carries raw call audio, so the fold does not get to decide on its
// own that plaintext is acceptable: `mediaSocketTransport` is the policy, and
// the caller that opens the call checks it before anything starts (bar S1,
// decision D2). Loopback and the tailnet keep the audio on this machine or on
// the encrypted Tailscale link; every other host needs TLS.

/** The websocket URL for the Gate's media socket, from the gateway's HTTP base. */
export function mediaSocketUrl(baseUrl: string, streamPath: string, protocolVersion?: 2): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const wsBase = trimmed.startsWith('https:')
    ? `wss:${trimmed.slice('https:'.length)}`
    : trimmed.startsWith('http:')
      ? `ws:${trimmed.slice('http:'.length)}`
      : trimmed;
  const path = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
  const url = `${wsBase}${path}`;
  return protocolVersion === 2 ? withVoiceProtocol(url, 2) : url;
}

/** Set the additive voice protocol query without leaving duplicate selectors. */
export function withVoiceProtocol(url: string, version: 1 | 2): string {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const withoutHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = withoutHash.indexOf('?');
  const path = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
  const params = queryAt >= 0
    ? withoutHash.slice(queryAt + 1).split('&').filter((part) => part && !/^protocol=/.test(part))
    : [];
  params.push(`protocol=${version}`);
  return `${path}?${params.join('&')}${hash}`;
}

export type MediaSocketTransportVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * The scheme and host of a URL, without a URL parser. React Native's `URL`
 * does not hand back an IPv6 host reliably, and this check is a security
 * decision, so it needs to fail closed on anything it cannot read rather than
 * guess.
 */
function socketAuthority(url: string): { scheme: string; host: string } | null {
  const value = url.trim().toLowerCase();
  // WHATWG URL parsers read `\` as `/` for ws:/http:, so `ws://evil\@127.0.0.1`
  // would reach evil while this parser saw loopback. Refuse rather than guess.
  if (/[\\\s]/.test(value)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(value);
  if (!scheme) return null;
  let authority = value.slice(scheme[0].length);
  const end = authority.search(/[/?#]/);
  if (end >= 0) authority = authority.slice(0, end);
  // Credentials are not the host: a tailnet-looking user name in front of an
  // internet host must never decide the answer.
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  if (!authority) return null;
  if (authority.startsWith('[')) {
    // Bracketed IPv6, with or without a port.
    const close = authority.indexOf(']');
    if (close < 0) return null;
    return { scheme: scheme[1], host: authority.slice(1, close) };
  }
  const colon = authority.indexOf(':');
  const host = colon >= 0 ? authority.slice(0, colon) : authority;
  return host ? { scheme: scheme[1], host } : null;
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const octets = ipv4Octets(host);
  return octets !== null && octets[0] === 127;
}

function isTailnetHost(host: string): boolean {
  // MagicDNS: a Tailscale node is always a label under `ts.net`, never bare.
  if (host.endsWith('.ts.net') && host.length > '.ts.net'.length) return true;
  // 100.64.0.0/10, the carrier-grade NAT range Tailscale hands out.
  const octets = ipv4Octets(host);
  if (octets !== null && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  // fd7a:115c:a1e0::/48. A `::` run only ever replaces zero groups, so these
  // three hextets are literally present whenever the address is in the range.
  if (!host.includes(':')) return false;
  const [head] = host.split('::');
  const groups = head.split(':');
  return groups[0] === 'fd7a' && groups[1] === '115c' && groups[2] === 'a1e0';
}

/**
 * Whether the call's media socket may be opened to this URL. `wss:` is always
 * allowed, because the audio is encrypted wherever it goes; plaintext `ws:` is
 * allowed only to loopback or the tailnet, where it never leaves this machine
 * or the encrypted tailnet. There is deliberately no override, not even for a
 * Gate run with `--allow-plaintext` (D2): the refusal names what to change.
 *
 * Accepts either the Gateway's HTTP base or the folded socket URL — the answer
 * only depends on the scheme and the host.
 */
export function mediaSocketTransport(url: string): MediaSocketTransportVerdict {
  const parsed = socketAuthority(url);
  if (!parsed) {
    return { allowed: false, reason: 'the call audio URL does not name a host' };
  }
  if (parsed.scheme === 'wss' || parsed.scheme === 'https') return { allowed: true };
  if (parsed.scheme === 'ws' || parsed.scheme === 'http') {
    return isLoopbackHost(parsed.host) || isTailnetHost(parsed.host)
      ? { allowed: true }
      : { allowed: false, reason: 'plaintext to a host off this machine and the tailnet' };
  }
  return {
    allowed: false,
    reason: `the call audio URL is not a WebSocket URL (${parsed.scheme}:)`,
  };
}
