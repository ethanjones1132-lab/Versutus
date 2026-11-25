export type GatewayTransportSecurity = 'tls' | 'cleartext' | 'socket' | 'unknown';

export type GatewayTransportInfo = {
  security: GatewayTransportSecurity;
  label: string;
  detail: string;
  isEncrypted: boolean;
};

export type TlsTofuResult =
  | { kind: 'first-seen'; fingerprint: string }
  | { kind: 'unchanged'; fingerprint: string }
  | { kind: 'changed'; previousFingerprint: string; observedFingerprint: string }
  | { kind: 'none' };

// ─── Cleartext transport policy ────────────────────────────────────
// A profile carries a Bearer token and the device identity, so a plain
// `http:`/`ws:` URL is only usable to a host that is on the trusted local
// network. Encrypted schemes are always allowed. This predicate is the ONE
// decision: the profile save path and the request path both call it, so they
// cannot drift into disagreeing about a host.

const TS_NET_SUFFIX = '.ts.net';

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

/** Loopback, RFC 1918, and the CGNAT range Tailscale hands out. */
function isTrustedIpv4([a, b]: number[]): boolean {
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * An IPv6 host as its 16 bytes, or null when it is not one. A trailing dotted
 * quad (`::ffff:192.168.1.5`) is folded into the two groups it stands for, the
 * same shape the WHATWG parser canonicalises to.
 */
function ipv6Bytes(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;

  const collect = (text: string): number[] | null => {
    const out: number[] = [];
    for (const part of text.length === 0 ? [] : text.split(':')) {
      if (part.includes('.')) {
        const octets = ipv4Octets(part);
        if (!octets) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  const head = collect(halves[0]);
  const tail = halves.length === 2 ? collect(halves[1]) : null;
  if (!head || (halves.length === 2 && !tail)) return null;

  let groups: number[];
  if (halves.length === 2) {
    const zeros = 8 - head.length - (tail?.length ?? 0);
    if (zeros < 0) return null;
    groups = [...head, ...new Array<number>(zeros).fill(0), ...(tail ?? [])];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }

  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function allZeroThrough(bytes: number[], end: number): boolean {
  return bytes.slice(0, end).every((byte) => byte === 0);
}

function isTrustedIpv6(bytes: number[]): boolean {
  if (bytes.length !== 16) return false;
  // ::1 loopback.
  if (allZeroThrough(bytes, 15) && bytes[15] === 1) return true;
  // fc00::/7 unique-local (ULA).
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) are an IPv4 host in
  // disguise; trust the address they actually name, not the spelling.
  const mapped = allZeroThrough(bytes, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = allZeroThrough(bytes, 12);
  if (mapped || compatible) {
    return isTrustedIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }
  return false;
}

/**
 * A hostname as the comparison wants it: lower-case, without the brackets a
 * bracketed IPv6 literal arrives with, and without a trailing root dot.
 */
function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * Whether this URL is usable at all, from the transport's point of view:
 * `https:`/`wss:` anywhere, and `http:`/`ws:` only to a host on the trusted
 * local network — `localhost`, 127.0.0.0/8, `::1`, RFC 1918, 100.64/10, an
 * IPv6 ULA, or a `*.ts.net` MagicDNS name. Everything else is refused, as is
 * any URL this app does not know how to fetch.
 *
 * The `*.ts.net` suffix is a LABEL comparison on purpose: `notts.net` merely
 * ends in the same letters and is not a tailnet name.
 */
export function isTrustedCleartextHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'https:' || scheme === 'wss:') return true;
  if (scheme !== 'http:' && scheme !== 'ws:') return false;

  const host = normalizeHost(parsed.hostname);
  if (!host) return false;
  if (host === 'localhost') return true;

  const v6 = ipv6Bytes(host);
  if (v6) return isTrustedIpv6(v6);

  const v4 = ipv4Octets(host);
  if (v4) return isTrustedIpv4(v4);

  return host.length > TS_NET_SUFFIX.length && host.endsWith(TS_NET_SUFFIX);
}

/**
 * The refusal a caller throws, or null when the URL may be used. The message
 * names the URL the operator entered — not a redacted form of it — and the
 * reason, because the save sheet and the connection banner both show it to
 * someone who has to decide what to change.
 */
export function cleartextRefusalMessage(url: string): string | null {
  if (isTrustedCleartextHost(url)) return null;

  let host = url.trim();
  try {
    host = new URL(url.trim()).host || host;
  } catch {
    // Not a URL at all; the message still names exactly what was entered.
  }

  return (
    `Refusing cleartext transport to ${url}: ${host} is not on the trusted local network. ` +
    'Cleartext (http:/ws:) is allowed only to localhost, a private LAN address (RFC 1918), ' +
    'a Tailscale/CGNAT address (100.64/10), an IPv6 ULA, or a *.ts.net name — ' +
    'use https:/wss: for any other host.'
  );
}

/** Inspect URL transport without pretending that JS fetch performs pinning. */
export function inspectGatewayTransport(url: string, observedFingerprint?: string): GatewayTransportInfo {
  let scheme = '';
  try {
    scheme = new URL(url).protocol.toLowerCase();
  } catch {
    scheme = url.split(':')[0]?.toLowerCase() ?? '';
  }

  if (scheme === 'https:') {
    return {
      security: 'tls',
      label: 'TLS encrypted',
      detail: observedFingerprint
        ? 'Encrypted transport. Discovery fingerprint is recorded but not verified by Expo fetch.'
        : 'Encrypted transport. Certificate pinning is not enabled for this profile.',
      isEncrypted: true,
    };
  }
  if (scheme === 'wss:') {
    return {
      security: 'socket',
      label: 'Secure socket',
      detail: 'Secure WebSocket transport. Discovery fingerprint is recorded but not verified by Expo fetch.',
      isEncrypted: true,
    };
  }
  if (scheme === 'http:' || scheme === 'ws:') {
    const trusted = isTrustedCleartextHost(url);
    return {
      security: 'cleartext',
      label: trusted ? 'Cleartext transport' : 'Cleartext refused',
      detail: trusted
        ? 'Cleartext is allowed to this trusted local host. Use HTTPS/Tailscale Serve off your own network.'
        : 'Cleartext to a host off the trusted local network is refused. Use HTTPS/Tailscale Serve, or a localhost, private LAN, 100.64/10, IPv6 ULA or *.ts.net address.',
      isEncrypted: false,
    };
  }
  return {
    security: 'unknown',
    label: 'Transport unknown',
    detail: 'Verify the gateway URL before sending credentials.',
    isEncrypted: false,
  };
}

/**
 * Classify a fingerprint that was actually presented against a stored record.
 *
 * Fetch does not present a live certificate, so a caller must not pass the
 * stored value as the observation: that comparison can never be `changed`.
 * `changed` means a different fingerprint was presented and the caller prompts.
 * `first-seen` means no trusted baseline exists yet. It does not grant trust.
 */
export function checkTlsFingerprintTofu(
  profile: { tlsFingerprint?: string; tlsFingerprintTrusted?: boolean; tlsFingerprintFirstSeenAt?: number },
  observedFingerprint?: string,
): TlsTofuResult {
  if (!observedFingerprint) return { kind: 'none' };

  const stored = profile.tlsFingerprint;

  // A stored fingerprint that disagrees with what is presented is a change even
  // when the user never explicitly trusted it. Gateways added from LAN discovery
  // record the beacon's fingerprint but never set the trusted flag, so keying
  // this decision off `tlsFingerprintTrusted` alone would silently accept a
  // substituted certificate on the first connect — the exact substitution TOFU
  // exists to catch.
  if (stored && stored !== observedFingerprint) {
    return {
      kind: 'changed',
      previousFingerprint: stored,
      observedFingerprint,
    };
  }

  // Nothing stored, or stored and identical but not yet trusted: this connect is
  // the first *use*, so it establishes the trust baseline.
  if (!profile.tlsFingerprintTrusted) {
    return { kind: 'first-seen', fingerprint: observedFingerprint };
  }

  return { kind: 'unchanged', fingerprint: observedFingerprint };
}

export type BeaconFingerprintDecision =
  | { kind: 'none' }
  | { kind: 'record'; fingerprint: string }
  | { kind: 'changed'; previousFingerprint: string; observedFingerprint: string };

/**
 * A discovery beacon is the only presented fingerprint. The same value, or no
 * value, is not a prompt. A different value is the change the operator approves
 * or rejects. A first value is recorded and not trusted.
 */
export function beaconFingerprintDecision(
  saved: { tlsFingerprint?: string } | undefined,
  observed?: string,
): BeaconFingerprintDecision {
  const fingerprint = observed?.trim();
  if (!fingerprint) return { kind: 'none' };
  const stored = saved?.tlsFingerprint;
  if (!stored) return { kind: 'record', fingerprint };
  if (stored !== fingerprint) {
    return { kind: 'changed', previousFingerprint: stored, observedFingerprint: fingerprint };
  }
  return { kind: 'none' };
}
