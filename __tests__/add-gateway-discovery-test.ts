import {
  buildExplicitHostCandidates,
  buildGatewayCandidates,
} from '@/lib/gateway/candidates';

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

function readManualSetupSource(): string {
  const src = readProviderSource();
  const start = src.indexOf('const setupFromPcAddress = useCallback');
  const end = src.indexOf('// The connect cycle the auto-retry timer and the foreground heal both ride.', start);
  return src.slice(start, end);
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

test('manual setup probes only the typed host and does not wait on discovery', () => {
  const setup = readManualSetupSource();
  expect(setup).toContain('buildExplicitHostCandidates(host)');
  const src = readProviderSource();
  expect(setup).not.toContain('discoverForProbe');
  expect(setup).not.toContain('buildGatewayCandidates');
  expect(setup).not.toContain('configuredGatewayHosts()');
  expect(setup).not.toContain('savedUrls:');
  expect(setup).not.toContain('dropAlreadyWavedCandidates');
  expect(setup).not.toContain('unwavedCandidates');
  expect(setup).toContain('probeHighPriorityCandidates(\n        explicitCandidates,');
  expect(setup).toContain('explicitCandidates.slice(HIGH_PRIORITY_WAVE_SIZE)');
  expect(setup).toContain('const exactUrlGateways = gateways.filter((item) => item.url === probeResult.url);');
  expect(setup).toMatch(/resolveGatewayForUrl\([\s\S]*?exactUrlGateways,\s*\[\],\s*token/);

  const autoConnectStart = src.indexOf('const runAutoConnect = useCallback');
  const autoConnectEnd = src.indexOf('const refreshGateways', autoConnectStart);
  const autoConnect = src.slice(autoConnectStart, autoConnectEnd);
  expect(autoConnect).toContain('buildGatewayCandidates({');
  expect(autoConnect).toContain('if (explicitSetupPendingRef.current) return;');

  const addGatewayStart = src.indexOf('const addGateway = useCallback');
  const addGatewayEnd = src.indexOf('const gatewayRequest', addGatewayStart);
  expect(src.slice(addGatewayStart, addGatewayEnd)).toContain('explicitSetupPendingRef.current = false;');

  const retryStart = src.indexOf('const scheduleAutoRetry = useCallback');
  const retryEnd = src.indexOf('scheduleAutoRetryRef.current = scheduleAutoRetry', retryStart);
  expect(src.slice(retryStart, retryEnd)).toContain('explicitSetupPendingRef.current');
});

test('automatic candidate generation still keeps the explicit host at the head', () => {
  const explicit = buildExplicitHostCandidates('my-pc.ts.net');
  const full = buildGatewayCandidates({
    tailscaleHost: 'my-pc.ts.net',
    configuredHosts: ['other-pc.ts.net'],
    savedUrls: ['http://192.168.1.9:8642'],
    platform: 'ios',
  });
  expect(full.slice(0, explicit.length)).toEqual(explicit);
});
