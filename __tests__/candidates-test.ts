import { buildGatewayCandidates } from '@/lib/gateway/candidates';

describe('gateway candidate URLs', () => {
  test('a tailnet IP yields a DNS-free route and no unvalidatable TLS', () => {
    const urls = buildGatewayCandidates({
      configuredHosts: ['100.95.137.83'],
      includeLocalFallbacks: false,
    });
    // Serve's certificate is issued for the hostname, so https://<ip> can never
    // validate — probing it only burns the timeout budget. Gate :8760 is
    // preferred, Hermes :8642 remains as fallback.
    expect(urls).toEqual(['http://100.95.137.83:8760', 'http://100.95.137.83:8642']);
  });

  test('a tailnet hostname keeps the Serve HTTPS endpoint first', () => {
    const urls = buildGatewayCandidates({
      configuredHosts: ['ethanspc.tail3a1a8a.ts.net'],
      includeLocalFallbacks: false,
    });
    expect(urls[0]).toBe('https://ethanspc.tail3a1a8a.ts.net:443');
    expect(urls).toContain('http://ethanspc.tail3a1a8a.ts.net:8760');
    expect(urls).toContain('http://ethanspc.tail3a1a8a.ts.net:8642');
  });

  test('routes are ordered widest-reach first, LAN last', () => {
    // Hostname works anywhere DNS resolves; the tailnet IP works anywhere on
    // the tailnet without DNS; the LAN IP works only at home but needs neither.
    const urls = buildGatewayCandidates({
      configuredHosts: ['ethanspc.tail3a1a8a.ts.net', '100.95.137.83', '192.168.4.30'],
      includeLocalFallbacks: false,
    });
    expect(urls).toEqual([
      'https://ethanspc.tail3a1a8a.ts.net:443',
      'http://ethanspc.tail3a1a8a.ts.net:8760',
      'http://ethanspc.tail3a1a8a.ts.net:8642',
      'http://100.95.137.83:8760',
      'http://100.95.137.83:8642',
      'http://192.168.4.30:8760',
      'http://192.168.4.30:8642',
    ]);
  });

  test('hostname and IP together give a fallback when DNS is unavailable', () => {
    const urls = buildGatewayCandidates({
      configuredHosts: ['ethanspc.tail3a1a8a.ts.net', '100.95.137.83'],
      includeLocalFallbacks: false,
    });
    // Every hostname candidate needs DNS; the IP is the one that does not.
    expect(urls.some((url) => url.includes('100.95.137.83'))).toBe(true);
    expect(urls.filter((url) => url.startsWith('https://100.'))).toEqual([]);
  });

  test('an explicit host:port is used as-is (Gate on 8760)', () => {
    const urls = buildGatewayCandidates({
      configuredHosts: ['100.95.137.83:8760'],
      includeLocalFallbacks: false,
    });
    expect(urls).toEqual(['http://100.95.137.83:8760']);
  });

  // ONB-2: `validatePcAddress` now accepts a one-digit port, so a candidate
  // has to be able to form one — otherwise the field reads "ready" and the
  // address still never gets probed, which is the same defect one digit down.
  test('a one-digit explicit port forms exactly one candidate', () => {
    const urls = buildGatewayCandidates({
      configuredHosts: ['100.95.137.83:1'],
      includeLocalFallbacks: false,
    });
    expect(urls).toEqual(['http://100.95.137.83:1']);
  });

  test('an unprobeable port drops that host and leaves the rest of the wave', () => {
    // The fallbacks still answer: a saved setting written before the range was
    // checked must not empty the whole wave.
    const urls = buildGatewayCandidates({
      tailscaleHost: '100.95.137.83:99999',
      configuredHosts: ['192.168.4.30'],
    });
    expect(urls).not.toContain('http://100.95.137.83:99999');
    expect(urls).toContain('http://192.168.4.30:8760');
  });

  test('user-typed host is ordered before a sticky lastSuccessful Hermes URL', () => {
    const urls = buildGatewayCandidates({
      tailscaleHost: '100.95.137.83:8760',
      lastSuccessfulUrl: 'http://100.95.137.83:8642',
      includeLocalFallbacks: false,
    });
    expect(urls[0]).toBe('http://100.95.137.83:8760');
    expect(urls).toContain('http://100.95.137.83:8642');
  });
});
