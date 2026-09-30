import {
  advertisedIpv4,
  HostLookupError,
  hostLookupFailureCountForTests,
  ipv4FromExpoExtra,
  isHostLookupFailure,
  resetHostLookupMemoryForTests,
  rewriteHttpBaseHost,
  rewriteHttpUrlHost,
  withHostLookupRetry,
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

  test('sees a Node fetch wrapper whose cause object carries ENOTFOUND', () => {
    const wrapped = new TypeError('fetch failed', {
      cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'ethanspc.tail3a1a8a.ts.net' },
    });
    expect(isHostLookupFailure(wrapped)).toBe(true);
  });

  test('walks a nested cause chain to the underlying getaddrinfo message', () => {
    const nested = new TypeError('fetch failed', {
      cause: new Error('resolveDestination: getaddrinfo ENOTFOUND ethanspc.tail3a1a8a.ts.net', {
        cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo' },
      }),
    });
    expect(isHostLookupFailure(nested)).toBe(true);
  });

  test('does not mistake a wrapped refused-token or HTTP error for a lookup miss', () => {
    const refused = new TypeError('fetch failed', {
      cause: new Error('invalid api key'),
    });
    expect(isHostLookupFailure(refused)).toBe(false);
    const http = new TypeError('fetch failed', {
      cause: new Error('HTTP 500'),
    });
    expect(isHostLookupFailure(http)).toBe(false);
  });

  test('a webview-facing unknown value still matches by its own text', () => {
    expect(isHostLookupFailure('getaddrinfo ENOTFOUND ethanspc.tail3a1a8a.ts.net')).toBe(true);
    expect(isHostLookupFailure('invalid api key')).toBe(false);
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

  test('rewrites a full http stream URL onto the IPv4 and keeps the path', () => {
    expect(
      rewriteHttpUrlHost(
        'http://ethanspc.tail3a1a8a.ts.net:8760/v1/runs/r1/events',
        '100.95.137.83',
      ),
    ).toBe('http://100.95.137.83:8760/v1/runs/r1/events');
  });

  test('refuses to rewrite an https stream URL onto an IP', () => {
    expect(
      rewriteHttpUrlHost(
        'https://ethanspc.tail3a1a8a.ts.net:8760/v1/runs/r1/events',
        '100.95.137.83',
      ),
    ).toBeNull();
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

describe('withHostLookupRetry failure memory', () => {
  beforeEach(() => resetHostLookupMemoryForTests());
  afterEach(() => {
    resetHostLookupMemoryForTests();
    jest.useRealTimers();
  });

  const LOOKUP_MISS = 'fetch failed: getaddrinfo ENOTFOUND ethanspc.tail3a1a8a.ts.net';

  test('after a hostname failure the IPv4 is tried first', async () => {
    const calls: string[] = [];
    const attempt = (url: string) => {
      calls.push(url);
      if (url.includes('ethanspc.tail3a1a8a.ts.net')) {
        return Promise.reject(new Error(LOOKUP_MISS));
      }
      return Promise.resolve('ok');
    };

    // First call: no memory yet, so the hostname is tried first.
    await withHostLookupRetry('http://ethanspc.tail3a1a8a.ts.net:8760/x', ['100.95.137.83'], attempt);
    expect(calls).toEqual([
      'http://ethanspc.tail3a1a8a.ts.net:8760/x',
      'http://100.95.137.83:8760/x',
    ]);

    // Second call: within the 2-minute memory, the IPv4 goes first.
    calls.length = 0;
    await withHostLookupRetry('http://ethanspc.tail3a1a8a.ts.net:8760/x', ['100.95.137.83'], attempt);
    expect(calls).toEqual(['http://100.95.137.83:8760/x']);
  });

  test('the IPv4-first memory expires after two minutes', async () => {
    jest.useFakeTimers();
    const calls: string[] = [];
    const attempt = (url: string) => {
      calls.push(url);
      if (url.includes('ethanspc.tail3a1a8a.ts.net')) {
        return Promise.reject(new Error(LOOKUP_MISS));
      }
      return Promise.resolve('ok');
    };

    await withHostLookupRetry('http://ethanspc.tail3a1a8a.ts.net:8760/x', ['100.95.137.83'], attempt);
    expect(calls).toEqual([
      'http://ethanspc.tail3a1a8a.ts.net:8760/x',
      'http://100.95.137.83:8760/x',
    ]);

    // Just inside the window: still IPv4 first.
    calls.length = 0;
    await jest.advanceTimersByTimeAsync(119_000);
    await withHostLookupRetry('http://ethanspc.tail3a1a8a.ts.net:8760/x', ['100.95.137.83'], attempt);
    expect(calls).toEqual(['http://100.95.137.83:8760/x']);

    // Past the window: hostname first again.
    calls.length = 0;
    await jest.advanceTimersByTimeAsync(2_000);
    await withHostLookupRetry('http://ethanspc.tail3a1a8a.ts.net:8760/x', ['100.95.137.83'], attempt);
    expect(calls).toEqual([
      'http://ethanspc.tail3a1a8a.ts.net:8760/x',
      'http://100.95.137.83:8760/x',
    ]);
  });

  test('a hostname success clears the failure memory', async () => {
    const calls: string[] = [];
    let hostnameHealthy = false;
    const attempt = (url: string) => {
      calls.push(url);
      const isHostname = url.includes('ethanspc.tail3a1a8a.ts.net');
      if (isHostname && !hostnameHealthy) {
        return Promise.reject(new Error(LOOKUP_MISS));
      }
      if (!isHostname) {
        return Promise.reject(new Error('fetch failed: getaddrinfo ENOTFOUND 100.95.137.83'));
      }
      return Promise.resolve('ok');
    };

    // Call 1: hostname fails (mark set), IPv4 fails — HostLookupError.
    await expect(
      withHostLookupRetry('http://ethanspc.tail3a1a8a.ts.net:8760/x', ['100.95.137.83'], attempt),
    ).rejects.toBeInstanceOf(HostLookupError);

    // Call 2: hostname healthy. The mark puts the IPv4 first; it fails; the
    // hostname succeeds and clears the mark.
    hostnameHealthy = true;
    calls.length = 0;
    await withHostLookupRetry('http://ethanspc.tail3a1a8a.ts.net:8760/x', ['100.95.137.83'], attempt);
    expect(calls).toEqual([
      'http://100.95.137.83:8760/x',
      'http://ethanspc.tail3a1a8a.ts.net:8760/x',
    ]);

    // Call 3: mark cleared — hostname first again.
    calls.length = 0;
    await withHostLookupRetry('http://ethanspc.tail3a1a8a.ts.net:8760/x', ['100.95.137.83'], attempt);
    expect(calls).toEqual(['http://ethanspc.tail3a1a8a.ts.net:8760/x']);
  });

  test('marking a host prunes the marks that have expired', async () => {
    jest.useFakeTimers();
    const markFailure = (host: string) =>
      withHostLookupRetry(`http://${host}/x`, [], () =>
        Promise.reject(new Error(`fetch failed: getaddrinfo ENOTFOUND ${host}`)),
      );

    await expect(markFailure('a.ts.net')).rejects.toBeInstanceOf(HostLookupError);
    await expect(markFailure('b.ts.net')).rejects.toBeInstanceOf(HostLookupError);
    expect(hostLookupFailureCountForTests()).toBe(2);

    // A gateway that stops being probed (deleted, or a rotating beacon host)
    // must not keep its mark for the life of the process.
    await jest.advanceTimersByTimeAsync(121_000);
    await expect(markFailure('c.ts.net')).rejects.toBeInstanceOf(HostLookupError);
    expect(hostLookupFailureCountForTests()).toBe(1);
  });
});
