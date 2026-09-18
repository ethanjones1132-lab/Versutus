import {
  advertisedIpv4,
  HostLookupError,
  ipv4FromExpoExtra,
  isHostLookupFailure,
  rewriteHttpBaseHost,
} from '@/lib/gateway/host-lookup';

describe('a DNS blip is a lookup failure, not a gateway crash', () => {
  test('matches the Android UnknownHostException the phone actually throws', () => {
    const err = new Error(
      'fetch failed: java.net.UnknownHostException: Unable to resolve host "ethanspc.tail3a1a8a.ts.net"',
    );
    expect(isHostLookupFailure(err)).toBe(true);
  });

  test('matches getaddrinfo / ENOTFOUND and does not match a refused token', () => {
    expect(isHostLookupFailure(new Error('getaddrinfo ENOTFOUND ethanspc.tail3a1a8a.ts.net'))).toBe(true);
    expect(isHostLookupFailure(new Error('invalid api key'))).toBe(false);
    expect(isHostLookupFailure(new Error('HTTP 500'))).toBe(false);
  });
});

describe('retrying through an advertised IPv4', () => {
  test('rewrites an http hostname onto the IPv4 and keeps the port', () => {
    expect(rewriteHttpBaseHost('http://ethanspc.tail3a1a8a.ts.net:8760', '100.95.137.83')).toBe(
      'http://100.95.137.83:8760',
    );
  });

  test('refuses to rewrite an https URL onto an IP', () => {
    expect(rewriteHttpBaseHost('https://ethanspc.tail3a1a8a.ts.net:8760', '100.95.137.83')).toBeNull();
  });

  test('does not silently turn https into http', () => {
    const rewritten = rewriteHttpBaseHost('https://ethanspc.tail3a1a8a.ts.net', '100.95.137.83');
    expect(rewritten).toBeNull();
  });

  test('advertisedIpv4 keeps unique valid IPv4s and drops hostnames', () => {
    expect(
      advertisedIpv4({
        advertised: ['100.95.137.83', 'not-an-ip', '100.95.137.83'],
        configuredHosts: ['ethanspc.tail3a1a8a.ts.net', '192.168.4.30'],
      }),
    ).toEqual(['100.95.137.83', '192.168.4.30']);
  });

  test('ipv4FromExpoExtra reads extra.gatewayHosts and ignores hostnames', () => {
    expect(
      ipv4FromExpoExtra({
        gatewayHosts: ['ethanspc.tail3a1a8a.ts.net', '100.95.137.83', '192.168.4.30'],
      }),
    ).toEqual(['100.95.137.83', '192.168.4.30']);
    expect(ipv4FromExpoExtra(undefined)).toEqual([]);
  });
});

describe('HostLookupError', () => {
  test('names the hostname and never the raw Java exception', () => {
    const err = new HostLookupError('ethanspc.tail3a1a8a.ts.net');
    expect(err.message).toMatch(/could not look up your PC's address/i);
    expect(err.message).toContain('ethanspc.tail3a1a8a.ts.net');
    expect(err.message).not.toMatch(/UnknownHostException/);
  });
});
