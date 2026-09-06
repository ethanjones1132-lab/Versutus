import { beaconKindForUrl } from '@/lib/gateway/candidates';

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
