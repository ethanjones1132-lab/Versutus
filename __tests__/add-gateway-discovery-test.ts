import {
  buildExplicitHostCandidates,
  buildGatewayCandidates,
} from '@/lib/gateway/candidates';
import { dropAlreadyWavedCandidates } from '@/lib/gateway/auto-connect-candidates';
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

test('a tailnet hostname expands to serve + gate + hermes with no local fallbacks', () => {
  expect(buildExplicitHostCandidates('my-pc.ts.net')).toEqual([
    'https://my-pc.ts.net:443',
    'http://my-pc.ts.net:8760',
    'http://my-pc.ts.net:8642',
  ]);
});

test('a tailnet IP expands to gate + hermes over plain http', () => {
  expect(buildExplicitHostCandidates('100.64.1.5')).toEqual([
    'http://100.64.1.5:8760',
    'http://100.64.1.5:8642',
  ]);
});

test('an explicit port is honored as the single candidate', () => {
  expect(buildExplicitHostCandidates('my-pc:8760')).toEqual(['http://my-pc:8760']);
});

test('a blank host yields no early candidates so the flow falls through', () => {
  expect(buildExplicitHostCandidates('')).toEqual([]);
  expect(buildExplicitHostCandidates('   ')).toEqual([]);
});

test('add-gateway probes the typed host while the discovery window runs', () => {
  const src = readProviderSource();
  const setup = src.slice(src.indexOf('const setupFromPcAddress = useCallback'));
  // Discovery is kicked off as a promise without awaiting it first, so its
  // fixed 2.5s window overlaps the synchronously-known explicit probe.
  expect(setup).toContain('const discoveryPromise = discoverForProbe(2500);');
  expect(setup).toContain('const discovered = await discoveryPromise;');
  expect(setup.indexOf('const discoveryPromise = discoverForProbe(2500);')).toBeLessThan(
    setup.indexOf('await probeHighPriorityCandidates'),
  );
  // The first wave carries only the typed host; the full candidate list
  // (discovered, saved, local fallbacks) is built only on an early miss.
  expect(setup).toContain('buildExplicitHostCandidates(host)');
  expect(setup).toContain('discovered,');
  expect(setup).toContain('savedUrls: gateways.map((item) => item.url),');
});

test('an early miss still probes every candidate across both waves', () => {
  const src = readProviderSource();
  const setup = src.slice(src.indexOf('const setupFromPcAddress = useCallback'));
  // The serial tail starts past the second wave's head instead of re-probing
  // it; the old full-list slice(3) overlap is gone.
  expect(setup).toContain('unwavedCandidates.slice(HIGH_PRIORITY_WAVE_SIZE)');
  expect(setup).not.toContain('candidates.slice(3)');
  // The resolved gateway still sees the landed beacons for kind matching.
  expect(setup).toContain('discovered,');
});

test('the full-list head is exactly the explicit host the first wave tried', () => {
  const explicit = buildExplicitHostCandidates('my-pc.ts.net');
  const full = buildGatewayCandidates({
    tailscaleHost: 'my-pc.ts.net',
    discovered: [
      {
        id: 'lan',
        name: 'lan',
        host: '192.168.1.20',
        port: 8642,
        url: 'http://192.168.1.20:8642',
        source: 'local',
        txt: {},
        lastSeenAt: 0,
      },
    ],
    platform: 'ios',
  });
  // Same strings through the same push path, so the first wave already
  // missed every one of them when the second wave runs.
  expect(full.slice(0, explicit.length)).toEqual(explicit);
  // Dropping the waved head keeps every unwaved candidate in listed order,
  // so earliest-healthy-wins is unchanged and nothing is probed twice.
  const delta = dropAlreadyWavedCandidates(full, explicit, []);
  expect(delta.length).toBe(full.length - explicit.length);
  expect(delta).toEqual(full.slice(explicit.length));
  for (const url of explicit) expect(delta).not.toContain(url);
});

test('add-gateway waves only the unwaved delta on an early miss', () => {
  const src = readProviderSource();
  const setup = src.slice(src.indexOf('const setupFromPcAddress = useCallback'));
  expect(setup).toContain('dropAlreadyWavedCandidates(candidates, explicitCandidates, [])');
  // The second wave probes the hoisted delta, so the tail below can start
  // past the head it already tried.
  expect(setup).toContain('unwavedCandidates,');
});

test('the three add-gateway waves cover every candidate exactly once', () => {
  const explicit = buildExplicitHostCandidates('my-pc.ts.net');
  const full = buildGatewayCandidates({
    tailscaleHost: 'my-pc.ts.net',
    configuredHosts: ['other-pc.ts.net'],
    savedUrls: ['http://192.168.1.9:8642'],
    discovered: [
      {
        id: 'lan',
        name: 'lan',
        host: '192.168.1.20',
        port: 8642,
        url: 'http://192.168.1.20:8642',
        source: 'local',
        txt: {},
        lastSeenAt: 0,
      },
    ],
    lastSuccessfulUrl: 'http://192.168.1.21:8642',
    platform: 'ios',
  });
  // Long enough that the serial tail is non-empty: explicit head plus a full
  // second-wave head plus at least one tail entry.
  expect(full.length).toBeGreaterThan(explicit.length + HIGH_PRIORITY_WAVE_SIZE);
  const delta = dropAlreadyWavedCandidates(full, explicit, []);
  expect(delta).toEqual(full.slice(explicit.length));
  // Mirror the provider: wave one takes the explicit head, wave two the
  // delta head, the tail starts past it.
  const waveOne = explicit.slice(0, HIGH_PRIORITY_WAVE_SIZE);
  const waveTwo = delta.slice(0, HIGH_PRIORITY_WAVE_SIZE);
  const tail = delta.slice(HIGH_PRIORITY_WAVE_SIZE);
  expect(tail.length).toBeGreaterThan(0);
  // Every candidate is still probed at least once ...
  for (const url of full) {
    expect([...waveOne, ...waveTwo, ...tail]).toContain(url);
  }
  // ... and no URL is probed twice.
  const probed = [...waveOne, ...waveTwo, ...tail];
  expect(new Set(probed).size).toBe(probed.length);
});
