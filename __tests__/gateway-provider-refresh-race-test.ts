// ─── Capability and manifest refresh must not commit a superseded Gateway's facts
// refreshCapabilities answers for the client/Gateway it started against. A
// replacement — the attachClient supersede, an explicit disconnect, a delete, or
// a retirement teardown — bumps clientGenerationRef, and every write the refresh
// makes (capabilities, manifest, child-profile sync, roster, the checked stamp)
// must re-check that generation before committing. Otherwise a slow catalog or
// manifest read for a Gateway the operator already left populates the new
// Gateway's surface with the old one's catalog and commands. Pinned off the
// source, the way the rest of the provider suites pin theirs.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const provider = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = provider.indexOf(startMarker);
  const end = provider.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return provider.slice(start, end);
}

const refresh = sliceBetween(
  'const refreshCapabilities = useCallback',
  'const confirmPendingAction = useCallback',
);

describe('capability and manifest refresh is scoped to the Gateway that started it', () => {
  test('the refresh captures the client generation it starts against', () => {
    expect(refresh).toContain('const generation = clientGenerationRef.current;');
    expect(refresh).toContain('const isCurrent = () => clientGenerationRef.current === generation;');
  });

  test('a capabilities answer only lands while the client that asked is still current', () => {
    expect(refresh).toContain('void client\n          .getCapabilities()\n          .then((capabilities) => {');
    expect(refresh).toContain('if (isCurrent()) setLiveCapabilities(capabilities);');
    expect(refresh).not.toContain('then(setLiveCapabilities)');
  });

  test('every await re-checks currency before its commit point', () => {
    // healthCheck, loadGateways, the manifest read, the child-profile sync, the
    // retired-store clear, and the final checked stamp each sit behind a guard.
    const guards = refresh.match(/if \(!isCurrent\(\)\) return;/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });

  test('a manifest read that completes after a Gateway replacement is discarded', () => {
    expect(refresh).toMatch(/\)\.catch\(\(\) => null\);\s*if \(!isCurrent\(\)\) return;\s*if \(manifest\) \{/);
    const write = refresh.indexOf('setActiveManifest(manifest);');
    expect(write).toBeGreaterThan(-1);
    // The currency check sits between the manifest read and its commit, so a
    // read finishing after a replacement never reaches the write.
    const head = refresh.slice(refresh.indexOf('.catch(() => null);') + '.catch(() => null);'.length, write);
    expect(head).toMatch(/if \(!isCurrent\(\)\) return;/);
  });

  test('a child-profile sync for a superseded Gateway is never committed', () => {
    const syncAt = refresh.indexOf('const retirement = await syncChildProfiles(activeGateway, manifestProviders(manifest));');
    expect(syncAt).toBeGreaterThan(-1);
    const after = refresh.slice(syncAt, refresh.indexOf('setGateways(retirement.gateways);'));
    expect(after).toContain('if (!isCurrent()) return;');
  });

  test('the retired-store clear and roster install only run for a still-current sync', () => {
    const storeAt = refresh.indexOf('await clearRetiredGatewayStores(retirement.removedIds);');
    expect(storeAt).toBeGreaterThan(-1);
    const after = refresh.slice(storeAt, refresh.indexOf('setGateways(retirement.gateways);'));
    expect(after).toContain('if (!isCurrent()) return;');
  });

  test('a successful current refresh still updates capabilities, manifest, child Bots, and the roster', () => {
    expect(refresh).toContain('setActiveManifest(manifest);');
    expect(refresh).toContain('const retirement = await syncChildProfiles(activeGateway, manifestProviders(manifest));');
    expect(refresh).toContain('teardownRetiredActiveGateway(retirement.removedIds, retirement.gateways);');
    expect(refresh).toContain('setGateways(retirement.gateways);');
    expect(refresh).toMatch(/if \(!isCurrent\(\)\) return;\s*setCapabilityCheckedAt\(Date\.now\(\)\);/);
    expect(refresh.match(/setActiveManifest\(/g)).toHaveLength(1);
  });

  test('a failed refresh preserves the last known manifest', () => {
    // The seam resolves null on exhaustion, so `if (manifest)` still refuses to
    // write anything on a failed refresh — and the currency guard adds a
    // superseded read to the same refusal.
    expect(refresh).toContain('.catch(() => null);');
    expect(refresh).toMatch(/if \(manifest\) \{\s*\n\s*setActiveManifest\(manifest\);/);
  });

  test('every replacement seam bumps the generation a refresh observes', () => {
    expect(provider.match(/clientGenerationRef\.current \+= 1;/g) ?? []).toHaveLength(4);
  });
});