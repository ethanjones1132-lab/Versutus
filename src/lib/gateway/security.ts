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
    return {
      security: 'cleartext',
      label: 'Cleartext transport',
      detail: 'Use HTTPS/Tailscale Serve for remote gateways. Cleartext is intended for trusted local networks only.',
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
