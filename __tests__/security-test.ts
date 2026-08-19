import { checkTlsFingerprintTofu, inspectGatewayTransport } from '@/lib/gateway/security';

describe('inspectGatewayTransport', () => {
  it('reports TLS for https URLs', () => {
    const info = inspectGatewayTransport('https://example.com');
    expect(info.security).toBe('tls');
    expect(info.isEncrypted).toBe(true);
  });

  it('reports cleartext for http URLs', () => {
    const info = inspectGatewayTransport('http://example.com');
    expect(info.security).toBe('cleartext');
    expect(info.isEncrypted).toBe(false);
  });
});

describe('checkTlsFingerprintTofu', () => {
  it('returns none when no fingerprint is observed', () => {
    expect(checkTlsFingerprintTofu({}, undefined)).toEqual({ kind: 'none' });
  });

  it('marks first seen when the profile has not trusted a fingerprint yet', () => {
    expect(checkTlsFingerprintTofu({}, 'abc123')).toEqual({ kind: 'first-seen', fingerprint: 'abc123' });
  });

  it('reports unchanged when the observed fingerprint matches the trusted one', () => {
    const profile = {
      tlsFingerprint: 'abc123',
      tlsFingerprintTrusted: true,
      tlsFingerprintFirstSeenAt: 1,
    };
    expect(checkTlsFingerprintTofu(profile, 'abc123')).toEqual({ kind: 'unchanged', fingerprint: 'abc123' });
  });

  it('reports changed when the observed fingerprint differs from the trusted one', () => {
    const profile = {
      tlsFingerprint: 'abc123',
      tlsFingerprintTrusted: true,
      tlsFingerprintFirstSeenAt: 1,
    };
    expect(checkTlsFingerprintTofu(profile, 'def456')).toEqual({
      kind: 'changed',
      previousFingerprint: 'abc123',
      observedFingerprint: 'def456',
    });
  });

  // The four quadrants of (stored fingerprint?) x (trusted?). The untrusted-but-
  // stored row is the one that matters: gateways added from LAN discovery record
  // a fingerprint from the beacon and never set the trusted flag, so treating
  // "not trusted" as "first seen" would silently accept a substituted
  // certificate on exactly the transport this feature exists to protect.
  describe('stored but never explicitly trusted', () => {
    const discovered = { tlsFingerprint: 'AA:AA:AA' };

    it('reports changed when a discovered fingerprint differs from what is presented', () => {
      expect(checkTlsFingerprintTofu(discovered, 'BB:BB:BB')).toEqual({
        kind: 'changed',
        previousFingerprint: 'AA:AA:AA',
        observedFingerprint: 'BB:BB:BB',
      });
    });

    it('treats a matching discovered fingerprint as the first trusted use', () => {
      expect(checkTlsFingerprintTofu(discovered, 'AA:AA:AA')).toEqual({
        kind: 'first-seen',
        fingerprint: 'AA:AA:AA',
      });
    });

    it('is still first-seen when nothing was ever stored', () => {
      expect(checkTlsFingerprintTofu({ tlsFingerprintTrusted: false }, 'BB:BB:BB')).toEqual({
        kind: 'first-seen',
        fingerprint: 'BB:BB:BB',
      });
    });

    it('does not treat an explicit trusted:false with a matching hash as a change', () => {
      const profile = { tlsFingerprint: 'AA:AA:AA', tlsFingerprintTrusted: false };
      expect(checkTlsFingerprintTofu(profile, 'AA:AA:AA')).toEqual({
        kind: 'first-seen',
        fingerprint: 'AA:AA:AA',
      });
    });
  });
});
