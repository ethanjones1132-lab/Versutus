import { beaconKindForUrl } from '@/lib/gateway/candidates';
import { probeGatewayCandidates, probeHighPriorityCandidates } from '@/lib/gateway/probe';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readProviderSource(): string {
  return readSource(['src', 'context', 'gateway-provider.tsx']);
}

function readIdentifySource(): string {
  return readSource(['src', 'lib', 'portal', 'identify.ts']);
}

test('a discovered beacon kind is handed through for the probed url', () => {
  const discovered = [
    { url: 'http://192.168.1.20:8642', kind: 'hermes' },
    { url: 'http://192.168.1.21:8642', kind: 'openclaw' },
  ];
  expect(beaconKindForUrl(discovered, 'http://192.168.1.20:8642')).toBe('hermes');
  expect(beaconKindForUrl(discovered, 'http://192.168.1.21:8642')).toBe('openclaw');
});

test('an unknown url, a missing kind, or a blank kind falls back to undefined', () => {
  expect(beaconKindForUrl([{ url: 'http://a:8642', kind: 'hermes' }], 'http://b:8642')).toBeUndefined();
  expect(beaconKindForUrl([{ url: 'http://a:8642' }], 'http://a:8642')).toBeUndefined();
  expect(beaconKindForUrl([{ url: 'http://a:8642', kind: '   ' }], 'http://a:8642')).toBeUndefined();
  expect(beaconKindForUrl([], 'http://a:8642')).toBeUndefined();
});

test('resolveGatewayForUrl passes the discovery beacon kind into identifyGateway', () => {
  const provider = readProviderSource();
  // The beacon kind travels with the identify call instead of re-fingerprinting.
  expect(provider).toContain('beaconKind: beaconKindForUrl(discovered, url)');
  // The concrete-kind gate before saving is untouched: only a resolved
  // custom/hermes/openclaw kind is kept, and identify still never throws.
  expect(provider).toContain(
    "if (identity.kind === 'custom' || identity.kind === 'hermes' || identity.kind === 'openclaw')",
  );
});

test('the beacon fast path resolves a concrete kind with no network', () => {
  const identify = readIdentifySource();
  // A known beacon kind returns before any fetch, so the connect path pays
  // zero round-trips when discovery already advertised the kind.
  expect(identify).toContain('if (options.beaconKind)');
  expect(identify).toContain("source: 'beacon'");
});

describe('probe wave manifest flag', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  function healthResponse() {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as unknown as Response;
  }

  function manifestResponse() {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ manifest: 'versutus-gateway/1.0' }),
    } as unknown as Response;
  }

  function noManifestResponse() {
    return {
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    } as unknown as Response;
  }

  function routeFetch(manifestHosts: string[]) {
    return jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/.well-known/gateway.json')) {
        const host = manifestHosts.find((h) => url.startsWith(h));
        return Promise.resolve(host ? manifestResponse() : noManifestResponse());
      }
      return Promise.resolve(healthResponse());
    });
  }

  test('a manifest-bearing wave winner carries hasManifest: true', async () => {
    (globalThis as { fetch: unknown }).fetch = routeFetch(['http://gate:8642']);
    const result = await probeHighPriorityCandidates(
      ['http://bare:8641', 'http://gate:8642'],
      undefined,
      2000,
    );
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://gate:8642');
    expect(result?.ok && result.hasManifest).toBe(true);
  });

  test('a manifest-less wave winner carries hasManifest: false so identify skips its replay', async () => {
    (globalThis as { fetch: unknown }).fetch = routeFetch([]);
    const result = await probeHighPriorityCandidates(
      ['http://a:8641', 'http://b:8642'],
      undefined,
      2000,
    );
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://a:8641');
    expect(result?.ok && result.hasManifest).toBe(false);
  });

  test('a serial-tail winner carries no flag so identify still runs its authoritative fetch', async () => {
    const fetchMock = routeFetch(['http://a:8641']);
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    // The serial pool never checks the manifest — even a manifest-serving
    // host arrives unflagged, so the connect path must not skip its fetch.
    const result = await probeGatewayCandidates(['http://a:8641'], undefined, 2000);
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.hasManifest).toBeUndefined();
  });
});

test('resolveGatewayForUrl hands skipManifest into identifyGateway', () => {
  const provider = readProviderSource();
  // The wave-learned answer travels into the cascade instead of being
  // re-fetched; tail-path winners arrive unflagged and keep the full read.
  expect(provider).toContain(
    'beaconKind: beaconKindForUrl(discovered, url), skipManifest',
  );
});

test('both connect paths skip the replay only for a known manifest-less winner', () => {
  const provider = readProviderSource();
  // Auto-connect and add-gateway each pass the flag once; an undefined flag
  // (tail winner, single-url probe) is never coerced into a skip.
  const passes = provider.match(/probeResult\.hasManifest === false/g) ?? [];
  expect(passes.length).toBe(2);
});
