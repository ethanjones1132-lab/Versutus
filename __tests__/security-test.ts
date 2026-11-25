import { readFileSync } from 'fs';
import path from 'path';

import { beaconFingerprintDecision, checkTlsFingerprintTofu, cleartextRefusalMessage, inspectGatewayTransport, isTrustedCleartextHost } from '@/lib/gateway/security';

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

  it('names an untrusted cleartext host as refused, not merely unencrypted', () => {
    expect(inspectGatewayTransport('http://example.com').label).toBe('Cleartext refused');
    expect(inspectGatewayTransport('http://192.168.1.9:5599').label).toBe('Cleartext transport');
  });
});

describe('isTrustedCleartextHost', () => {
  // The trusted set is one decision, pinned here character for character. Every
  // entry is an address this app may send a Bearer token to over http:/ws:.
  describe('accepts the trusted local network', () => {
    const TRUSTED = [
      'http://localhost:5599',
      'http://localhost.:5599',
      'http://127.0.0.1:5599',
      'http://127.42.0.9',
      'http://10.0.0.5:8760',
      'http://172.16.0.1',
      'http://172.31.255.254',
      'http://192.168.1.9:5599',
      'http://100.64.0.1',
      'http://100.100.1.2',
      'http://100.127.255.254',
      'http://[::1]:5599',
      'http://[fc00::1]',
      'http://[fd12:3456:789a::2]:8760',
      'http://box.tail1234.ts.net',
      'http://box.tail1234.ts.net.:8760',
      'http://box.TAIL1234.TS.NET',
      'ws://192.168.1.9:5599/socket',
      'wss://example.com/socket',
      'https://example.com',
    ];

    it.each(TRUSTED)('%s', (url) => {
      expect(isTrustedCleartextHost(url)).toBe(true);
      expect(cleartextRefusalMessage(url)).toBeNull();
    });
  });

  describe('refuses everything else over cleartext', () => {
    const REFUSED = [
      'http://example.com',
      'http://example.com:8760',
      'http://8.8.8.8',
      'http://172.15.0.1',
      'http://172.32.0.1',
      'http://100.63.255.255',
      'http://100.128.0.1',
      'http://192.169.0.1',
      'http://127.example.com',
      'http://notts.net',
      'http://notts.net.:8760',
      'http://ts.net',
      'http://box.ts.net.evil.com',
      'http://my-pc.tail1234.ts.net.evil.com',
      'http://[2001:db8::1]',
      'http://[2001:db8::1]:5599',
      'http://[::ffff:8.8.8.8]',
      'ws://example.com/socket',
      'ftp://192.168.1.9',
      'not a url',
    ];

    it.each(REFUSED)('%s', (url) => {
      expect(isTrustedCleartextHost(url)).toBe(false);
      expect(cleartextRefusalMessage(url)).not.toBeNull();
    });
  });

  it('allows https to any host and never asks about its hostname', () => {
    expect(isTrustedCleartextHost('https://example.com')).toBe(true);
    expect(cleartextRefusalMessage('https://example.com')).toBeNull();
    expect(isTrustedCleartextHost('https://notts.net')).toBe(true);
  });

  it('names the URL and the reason in the refusal', () => {
    const message = cleartextRefusalMessage('http://example.com:8760');
    expect(message).toContain('http://example.com:8760');
    expect(message).toContain('trusted local network');
    expect(message).toContain('https:');
  });

  it('treats a bracketed IPv6 loopback like loopback and an ULA like a private LAN', () => {
    expect(isTrustedCleartextHost('http://[0:0:0:0:0:0:0:1]:5599')).toBe(true);
    expect(isTrustedCleartextHost('http://[FD00::5]')).toBe(true);
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

describe('stored fingerprints are discovery records', () => {
  const provider = readFileSync(path.join(__dirname, '../src/context/gateway-provider.tsx'), 'utf8');
  const card = readFileSync(path.join(__dirname, '../src/components/gateway/transport-security-card.tsx'), 'utf8');

  test('connect does not compare the stored fingerprint with itself', () => {
    expect(provider).not.toContain('checkTlsFingerprintTofu(gateway, gateway.tlsFingerprint)');
    expect(provider).toContain('beaconFingerprintDecision(saved, observed)');
  });

  test('a different beacon fingerprint is the only prompt, and it is not trusted', () => {
    expect(beaconFingerprintDecision({ tlsFingerprint: 'AA' }, 'BB')).toEqual({
      kind: 'changed',
      previousFingerprint: 'AA',
      observedFingerprint: 'BB',
    });
    expect(beaconFingerprintDecision({ tlsFingerprint: 'AA' }, 'AA')).toEqual({ kind: 'none' });
    expect(beaconFingerprintDecision(undefined, 'BB')).toEqual({ kind: 'record', fingerprint: 'BB' });
    expect(beaconFingerprintDecision({ tlsFingerprint: 'AA' }, '  ')).toEqual({ kind: 'none' });
  });

  test('the saved fingerprint is labelled as a discovery record', () => {
    expect(card).toContain('Discovery fingerprint:');
    expect(card).not.toContain('Observed fingerprint:');
  });
});
