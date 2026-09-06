import {
  buildEarlyProbeUrls,
  dropAlreadyWavedCandidates,
  mergeDiscoveredProbeUrls,
  sameGatewayUrl,
} from '@/lib/gateway/auto-connect-candidates';
import { HIGH_PRIORITY_WAVE_SIZE } from '@/lib/gateway/probe';

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

test('web builds loopbacks first with the last success behind them, deduped', () => {
  expect(
    buildEarlyProbeUrls({ platform: 'web', lastSuccessfulUrl: 'https://abc.ts.net:8765' }),
  ).toEqual(['http://127.0.0.1:8642', 'http://localhost:8642', 'https://abc.ts.net:8765']);
  // A last success that is already a loopback is not probed twice.
  expect(
    buildEarlyProbeUrls({ platform: 'web', lastSuccessfulUrl: 'http://localhost:8642' }),
  ).toEqual(['http://127.0.0.1:8642', 'http://localhost:8642']);
});

test('native builds only the last success, or nothing without one', () => {
  expect(
    buildEarlyProbeUrls({ platform: 'ios', lastSuccessfulUrl: 'https://abc.ts.net:8765' }),
  ).toEqual(['https://abc.ts.net:8765']);
  expect(buildEarlyProbeUrls({ platform: 'android', lastSuccessfulUrl: null })).toEqual([]);
  expect(buildEarlyProbeUrls({ platform: 'ios' })).toEqual([]);
});

test('discovered beacons merge behind the early urls with no duplicates', () => {
  const early = ['http://127.0.0.1:8642', 'https://abc.ts.net:8765'];
  const merged = mergeDiscoveredProbeUrls(early, [
    { url: 'https://abc.ts.net:8765' },
    { url: 'http://192.168.1.20:8642' },
  ]);
  expect(merged).toEqual([
    'http://127.0.0.1:8642',
    'https://abc.ts.net:8765',
    'http://192.168.1.20:8642',
  ]);
  // The input list is not mutated.
  expect(early).toEqual(['http://127.0.0.1:8642', 'https://abc.ts.net:8765']);
});

test('the saved-gateway comparison ignores a trailing slash', () => {
  expect(sameGatewayUrl('http://x:8642', 'http://x:8642/')).toBe(true);
  expect(sameGatewayUrl('http://x:8642/', 'http://x:8642')).toBe(true);
  expect(sameGatewayUrl('http://x:8642', 'http://y:8642')).toBe(false);
});

test('auto-connect starts discovery before the first probe and merges after', () => {
  const src = readProviderSource();
  const runAutoConnect = src.slice(src.indexOf('const runAutoConnect = useCallback'));
  // Discovery is kicked off as a promise without awaiting it first, so its
  // fixed window overlaps the synchronously-known probes.
  expect(runAutoConnect).toContain('const discoveryPromise = discoverForProbe();');
  expect(runAutoConnect).toContain('const discovered = await discoveryPromise;');
  expect(runAutoConnect.indexOf('const discoveryPromise = discoverForProbe();')).toBeLessThan(
    runAutoConnect.indexOf('await probeHighPriorityCandidates'),
  );
  // The merged list still carries discovered beacons into every downstream use.
  expect(runAutoConnect).toContain('mergeDiscoveredProbeUrls(earlyUrls, discovered)');
  expect(runAutoConnect).toContain('discovered,');
});

test('an early success for the saved url skips the second probe of it', () => {
  const src = readProviderSource();
  const runAutoConnect = src.slice(src.indexOf('const runAutoConnect = useCallback'));
  expect(runAutoConnect).toContain('sameGatewayUrl(earlyResult.url, saved.url)');
});

test('the fallback drops exactly the wave heads and keeps listed order', () => {
  expect(HIGH_PRIORITY_WAVE_SIZE).toBe(4);
  const early = ['http://127.0.0.1:8642', 'https://abc.ts.net:8765'];
  const merged = [...early, 'http://192.168.1.20:8642', 'http://192.168.1.21:8642'];
  const candidates = [
    'https://abc.ts.net:8765',
    'http://127.0.0.1:8642',
    'http://192.168.1.20:8642',
    'http://192.168.1.21:8642',
    'http://10.0.2.2:8760',
  ];
  // Every waved URL is dropped; the unwaved delta keeps fallback order so
  // earliest-healthy-wins is unchanged.
  expect(dropAlreadyWavedCandidates(candidates, early, merged)).toEqual([
    'http://10.0.2.2:8760',
  ]);
});

test('beacons past the wave head are never dropped', () => {
  const early = ['http://127.0.0.1:8642'];
  const beacons = [
    'http://192.168.1.20:8642',
    'http://192.168.1.21:8642',
    'http://192.168.1.22:8642',
    'http://192.168.1.23:8642',
    'http://192.168.1.24:8642',
  ];
  const merged = [...early, ...beacons];
  // The merged wave probes only its first 4 entries, so the 5th and 6th
  // beacons were never tried and must still reach the fallback pool.
  expect(dropAlreadyWavedCandidates(beacons, early, merged)).toEqual([
    'http://192.168.1.23:8642',
    'http://192.168.1.24:8642',
  ]);
});

test('the fallback drop is slash-insensitive and keeps everything when nothing waved', () => {
  expect(
    dropAlreadyWavedCandidates(['http://x:8642/'], ['http://x:8642'], ['http://x:8642']),
  ).toEqual([]);
  expect(dropAlreadyWavedCandidates(['http://x:8642'], [], [])).toEqual(['http://x:8642']);
});

test('auto-connect filters the fallback through the waved drop', () => {
  const src = readProviderSource();
  const runAutoConnect = src.slice(src.indexOf('const runAutoConnect = useCallback'));
  expect(runAutoConnect).toContain('dropAlreadyWavedCandidates(');
  expect(runAutoConnect).toContain('earlyUrls,\n            highPriorityUrls,');
});
