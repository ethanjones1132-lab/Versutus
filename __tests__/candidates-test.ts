import { buildGatewayCandidates } from '@/lib/gateway/candidates';

describe('gateway candidate URLs', () => {
  test('a tailnet IP yields a DNS-free route and no unvalidatable TLS', () => {
    const urls = buildGatewayCandidates({
      configuredHosts: ['100.95.137.83'],
      includeLocalFallbacks: false,
    });
    // Serve's certificate is issued for the hostname, so https://<ip> can never
    // validate — probing it only burns the timeout budget.
    expect(urls).toEqual(['http://100.95.137.83:8642']);
  });

  test('a tailnet hostname keeps the Serve HTTPS endpoint first', () => {
    const urls = buildGatewayCandidates({
      configuredHosts: ['ethanspc.tail3a1a8a.ts.net'],
      includeLocalFallbacks: false,
    });
    expect(urls[0]).toBe('https://ethanspc.tail3a1a8a.ts.net:443');
    expect(urls).toContain('http://ethanspc.tail3a1a8a.ts.net:8642');
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
});
