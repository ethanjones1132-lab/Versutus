declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readProviderSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const source = readProviderSource();

test('the provider imports the retry-aware manifest fetch and drops the bare one', () => {
  expect(source).toContain('fetchGatewayManifestWithLookupRetry,');
  expect(source).not.toContain('  fetchGatewayManifest,\n');
  expect(source).not.toContain('await fetchGatewayManifest(');
  expect(source).not.toContain('void fetchGatewayManifest(');
});

test('attachClient routes its manifest fetch through the DNS-fallback seam', () => {
  const attach = source.slice(
    source.indexOf('const attachClient = useCallback'),
    source.indexOf('const connectGateway = useCallback'),
  );
  // The first-well-known fetch on attach retries the profile's known IPv4s.
  expect(attach).toContain('fetchGatewayManifestWithLookupRetry(');
  expect(attach).toContain('manifestAlternateIpv4(gateway, null)');
  // The child-sync re-fetch after connect reuses the manifest just fetched,
  // so the freshly advertised tailnet IPv4s are the retry set.
  expect(attach).toContain('manifestAlternateIpv4(gateway, fetchedManifest)');
});

test('refreshCapabilities retries over the last-known manifest IPv4s', () => {
  const refresh = source.slice(
    source.indexOf('const refreshCapabilities = useCallback'),
    source.indexOf('const confirmPendingAction = useCallback'),
  );
  expect(refresh).toContain('fetchGatewayManifestWithLookupRetry(');
  expect(refresh).toContain('manifestAlternateIpv4(activeGateway, activeManifest)');
  expect(refresh).toContain('[activeGateway, status, teardownRetiredActiveGateway, activeManifest]');
});

test('a failed refresh cannot clear the last known manifest', () => {
  const refresh = source.slice(
    source.indexOf('const refreshCapabilities = useCallback'),
    source.indexOf('const confirmPendingAction = useCallback'),
  );
  // The only activeManifest write sits behind a served manifest, and the seam
  // resolves null (like the plain fetch) when the retries are exhausted, so a
  // MagicDNS blip during refresh leaves the last known manifest in place.
  expect(refresh).toMatch(/\)\.catch\(\(\) => null\);\s*if \(manifest\) \{/);
  expect(refresh.match(/setActiveManifest\(/g)).toHaveLength(1);
  expect(refresh).toMatch(/if \(manifest\) \{\s*\n\s*setActiveManifest\(manifest\);/);
});

test('manifestAlternateIpv4 spans the shared validator over profile and configured IPv4s', () => {
  expect(source).toContain('function manifestAlternateIpv4(');
  const helperStart = source.indexOf('function manifestAlternateIpv4(');
  const helper = source.slice(helperStart, source.indexOf('\nfunction ', helperStart + 10));
  expect(helper).toContain('advertisedIpv4({');
  expect(helper).toContain('advertised: manifest?.transport?.ipv4');
  expect(helper).toContain('configuredHosts: [...(gateway.alternateIpv4 ?? []), ...configuredGatewayHosts()]');
});