import { collapseDuplicateGateways, mergeIntoExistingGateway } from '@/lib/gateway/profile-dedupe';
import type { GatewayProfile } from '@/lib/gateway/types';

const profile = (overrides: Partial<GatewayProfile> & { id: string; url: string }): GatewayProfile => ({
  name: overrides.id,
  createdAt: 1,
  ...overrides,
});

// 2026-09-16: "Gateway" and "Ethanspc" were two saved profiles for the same
// Gate URL, created by two different add paths that never looked for an
// existing profile. One carried the token and one did not, so which one the
// app connected to decided whether requests authenticated.

describe('collapsing saved profiles that point at the same gateway', () => {
  test('two profiles for one URL become one, keeping the one that has the token', () => {
    const tokenless = profile({ id: 'gw-ethanspc', name: 'Ethanspc', url: 'http://ethanspc.tail3a1a8a.ts.net:8760', kind: 'custom' });
    const tokened = profile({ id: 'gw-gateway', name: 'Gateway', url: 'http://ethanspc.tail3a1a8a.ts.net:8760/', token: 'secret', kind: 'custom' });
    const result = collapseDuplicateGateways([tokenless, tokened], 'gw-ethanspc');
    expect(result.gateways).toHaveLength(1);
    expect(result.gateways[0].id).toBe('gw-gateway');
    expect(result.gateways[0].token).toBe('secret');
    expect(result.idMap).toEqual({ 'gw-ethanspc': 'gw-gateway' });
    expect(result.activeId).toBe('gw-gateway');
    expect(result.changed).toBe(true);
  });

  test("the kept profile gains what only the duplicate had, and keeps its own pins", () => {
    const a = profile({
      id: 'a', url: 'http://host:8760', token: 't',
      botModels: { anvil: 'kilo/glm-5.3' },
    });
    const b = profile({
      id: 'b', url: 'http://host:8760', sessionKey: 'sk', tlsFingerprint: 'fp', backendId: 'hermes-local',
      botModels: { anvil: 'other/model', ledger: 'nvidia/x' },
    });
    const [kept] = collapseDuplicateGateways([a, b], 'a').gateways;
    expect(kept.sessionKey).toBe('sk');
    expect(kept.tlsFingerprint).toBe('fp');
    expect(kept.backendId).toBe('hermes-local');
    // The kept profile's own pin wins; the duplicate only fills gaps.
    expect(kept.botModels).toEqual({ anvil: 'kilo/glm-5.3', ledger: 'nvidia/x' });
  });

  test('when neither has a token, the active profile is kept', () => {
    const result = collapseDuplicateGateways(
      [profile({ id: 'first', url: 'http://h:8760' }), profile({ id: 'active', url: 'http://h:8760' })],
      'active',
    );
    expect(result.gateways.map((g) => g.id)).toEqual(['active']);
  });

  test('children of a collapsed profile follow it; child profiles themselves are never merged', () => {
    const parentA = profile({ id: 'pa', url: 'http://h:8760', token: 't' });
    const parentB = profile({ id: 'pb', url: 'http://h:8760' });
    const childOfB = profile({ id: 'pb::nvidia', url: 'http://h:8760/p/nvidia', parentId: 'pb' });
    const result = collapseDuplicateGateways([parentA, parentB, childOfB], null);
    expect(result.gateways.map((g) => g.id)).toEqual(['pa', 'pb::nvidia']);
    expect(result.gateways.find((g) => g.id === 'pb::nvidia')?.parentId).toBe('pa');
  });

  test('different gateways are left exactly as they are', () => {
    const list = [
      profile({ id: 'home', url: 'http://home:8760', token: 't1' }),
      profile({ id: 'work', url: 'https://work.example.com', token: 't2' }),
    ];
    const result = collapseDuplicateGateways(list, 'home');
    expect(result.changed).toBe(false);
    expect(result.gateways).toEqual(list);
    expect(result.activeId).toBe('home');
  });
});

describe('adding a profile for a gateway that is already saved', () => {
  test('updates the saved profile instead of creating a second one, keeping a fresh token', () => {
    const saved = profile({ id: 'gw-gateway', name: 'Gateway', url: 'http://h:8760', token: 'old', botModels: { anvil: 'kilo/glm-5.3' } });
    const incoming = profile({ id: 'gw-new', name: 'Ethanspc', url: 'http://h:8760/', token: 'fresh', kind: 'custom' });
    const result = mergeIntoExistingGateway([saved], incoming);
    expect(result.gateways).toHaveLength(1);
    expect(result.profile.id).toBe('gw-gateway');
    expect(result.profile.token).toBe('fresh');
    expect(result.profile.kind).toBe('custom');
    // The operator's saved name and pins survive the re-add.
    expect(result.profile.name).toBe('Gateway');
    expect(result.profile.botModels).toEqual({ anvil: 'kilo/glm-5.3' });
  });

  test('an incoming profile with no token never erases the saved one', () => {
    const saved = profile({ id: 'gw', url: 'http://h:8760', token: 'keep-me' });
    const result = mergeIntoExistingGateway([saved], profile({ id: 'gw-new', url: 'http://h:8760' }));
    expect(result.profile.token).toBe('keep-me');
  });

  test('a genuinely new gateway is added as itself, at the top', () => {
    const saved = profile({ id: 'gw', url: 'http://h:8760' });
    const incoming = profile({ id: 'gw-other', url: 'http://other:8760' });
    const result = mergeIntoExistingGateway([saved], incoming);
    expect(result.profile).toBe(incoming);
    expect(result.gateways.map((g) => g.id)).toEqual(['gw-other', 'gw']);
  });
});

describe('the app uses the merge wherever a profile is born', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const path = jest.requireActual('path') as { join(...parts: string[]): string };
  const provider = nodeFs.readFileSync(path.join(__dirname, '..', 'src', 'context', 'gateway-provider.tsx'), 'utf8');

  test('no add path writes a freshly built profile straight to the store', () => {
    expect(provider).not.toContain('await upsertGateway(profile);');
    expect(provider.match(/addGatewayProfile\(created\)/g)?.length).toBe(3);
  });

  test('startup collapses saved duplicates before anything connects', () => {
    const bootstrap = provider.slice(provider.indexOf('const bootstrap = useCallback'));
    expect(bootstrap.slice(0, bootstrap.indexOf('runAutoConnect('))).toContain('repairDuplicateGateways()');
  });
});
