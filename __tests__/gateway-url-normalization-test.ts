import {
  hasImpossibleNumericOctets,
  isCanonicalIpv4,
  normalizeGatewayUrl,
} from '@/lib/gateway/url';

// The manual-add screen canonicalizes the operator's entry ONCE (add.tsx
// handleSave step 0) and uses that value for identify, the access handshake,
// AND the saved profile. These tests pin what "canonical" means so a paste
// artifact can never identify fine and then save wrong.
describe('normalizeGatewayUrl', () => {
  it('trims paste artifacts around an otherwise correct URL', () => {
    expect(normalizeGatewayUrl('  http://ethanspc.tail3a1a8a.ts.net:8760 \n')).toBe(
      'http://ethanspc.tail3a1a8a.ts.net:8760',
    );
  });

  it('repairs a missing scheme onto plain http', () => {
    expect(normalizeGatewayUrl('mybox.tail3a1a8a.ts.net:8760')).toBe(
      'http://mybox.tail3a1a8a.ts.net:8760',
    );
  });

  it('strips trailing slashes and paths from http(s) entries', () => {
    expect(normalizeGatewayUrl('http://gate.test:8760/')).toBe('http://gate.test:8760');
    expect(normalizeGatewayUrl('https://gate.test/gateway.json')).toBe('https://gate.test:443');
  });

  it('maps ws:// entries onto their http base, dropping the derived path', () => {
    // The screen's own placeholder advertises this form; adapters re-derive
    // the ws:// endpoint via httpToWsBase, so the stored base is http.
    expect(normalizeGatewayUrl('ws://192.168.4.30:7400/openclaw')).toBe('http://192.168.4.30:7400');
  });

  it('maps wss:// entries onto https', () => {
    expect(normalizeGatewayUrl('wss://gate.test/openclaw')).toBe('https://gate.test:443');
  });

  it('defaults a bare host to the Hermes API port', () => {
    expect(normalizeGatewayUrl('ethanspc.tail3a1a8a.ts.net')).toBe(
      'http://ethanspc.tail3a1a8a.ts.net:8642',
    );
  });

  it('is idempotent for every accepted shape', () => {
    const inputs = [
      'http://ethanspc.tail3a1a8a.ts.net:8760',
      'https://gate.test',
      'ws://192.168.4.30:7400/openclaw',
      'mybox.tail3a1a8a.ts.net:8760',
    ];
    for (const input of inputs) {
      expect(normalizeGatewayUrl(normalizeGatewayUrl(input))).toBe(normalizeGatewayUrl(input));
    }
  });

  it('still accepts canonical tailnet and LAN IPs, bounds included', () => {
    expect(normalizeGatewayUrl('100.64.1.1')).toBe('http://100.64.1.1:8642');
    expect(normalizeGatewayUrl('http://192.168.4.30:7400')).toBe('http://192.168.4.30:7400');
    expect(normalizeGatewayUrl('http://0.0.0.0')).toBe('http://0.0.0.0:8642');
    expect(normalizeGatewayUrl('255.255.255.255')).toBe('http://255.255.255.255:8642');
  });

  it('rejects a short dotted-decimal instead of silently padding an octet', () => {
    expect(() => normalizeGatewayUrl('1.2.3')).toThrow(/^Invalid gateway URL:/);
    expect(() => normalizeGatewayUrl('1.2')).toThrow(/^Invalid gateway URL:/);
    expect(() => normalizeGatewayUrl('1')).toThrow(/^Invalid gateway URL:/);
  });

  it('rejects a bare 32-bit integer the parser would read as some other IP', () => {
    expect(() => normalizeGatewayUrl('2130706433')).toThrow(/^Invalid gateway URL:/);
  });

  it('rejects octal and hex numeric hosts the parser would reinterpret', () => {
    expect(() => normalizeGatewayUrl('0250.168.0.1')).toThrow(/^Invalid gateway URL:/);
    expect(() => normalizeGatewayUrl('0x7f.0.0.1')).toThrow(/^Invalid gateway URL:/);
  });

  it('rejects impossible-octet hosts under every scheme form', () => {
    expect(() => normalizeGatewayUrl('999.999.999.999')).toThrow(/^Invalid gateway URL:/);
    expect(() => normalizeGatewayUrl('http://999.999.999.999:8760')).toThrow(/^Invalid gateway URL:/);
    expect(() => normalizeGatewayUrl('256.1.1.1')).toThrow(/^Invalid gateway URL:/);
    expect(() => normalizeGatewayUrl('https://300.1.1.1')).toThrow(/^Invalid gateway URL:/);
  });

  it('rejects an empty entry with the required message', () => {
    expect(() => normalizeGatewayUrl('   ')).toThrow('Gateway URL is required');
  });

  it('rejects a hostless entry with the invalid-URL message the screen surfaces', () => {
    expect(() => normalizeGatewayUrl('http://')).toThrow(/^Invalid gateway URL:/);
  });
});

describe('numeric-host validation shared with onboarding', () => {
  it('classifies canonical dotted-quads as plain IPv4', () => {
    expect(isCanonicalIpv4('192.168.4.30')).toBe(true);
    expect(isCanonicalIpv4('100.64.1.1')).toBe(true);
    expect(isCanonicalIpv4('0.0.0.0')).toBe(true);
    expect(isCanonicalIpv4('255.255.255.255')).toBe(true);
  });

  it('flags out-of-range, short, and reinterpretable numeric hosts', () => {
    expect(hasImpossibleNumericOctets('999.999.999.999')).toBe(true);
    expect(hasImpossibleNumericOctets('256.1.1.1')).toBe(true);
    expect(hasImpossibleNumericOctets('1.2.3.4.5')).toBe(true);
    expect(hasImpossibleNumericOctets('1.2.3')).toBe(true);
    expect(hasImpossibleNumericOctets('2130706433')).toBe(true);
    expect(hasImpossibleNumericOctets('0250.168.0.1')).toBe(true);
    expect(hasImpossibleNumericOctets('0x7f.0.0.1')).toBe(true);
  });

  it('never applies the octet check to real hostnames', () => {
    expect(hasImpossibleNumericOctets('ethanspc.tail3a1a8a.ts.net')).toBe(false);
    expect(hasImpossibleNumericOctets('gate.test')).toBe(false);
    expect(hasImpossibleNumericOctets('mybox')).toBe(false);
  });
});
