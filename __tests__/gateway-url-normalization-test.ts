import { normalizeGatewayUrl } from '@/lib/gateway/url';

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

  it('rejects an empty entry with the required message', () => {
    expect(() => normalizeGatewayUrl('   ')).toThrow('Gateway URL is required');
  });

  it('rejects a hostless entry with the invalid-URL message the screen surfaces', () => {
    expect(() => normalizeGatewayUrl('http://')).toThrow(/^Invalid gateway URL:/);
  });
});
