export type GatewayTransportSecurity = 'tls' | 'cleartext' | 'socket' | 'unknown';

export type GatewayTransportInfo = {
  security: GatewayTransportSecurity;
  label: string;
  detail: string;
  isEncrypted: boolean;
};

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
