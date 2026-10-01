import { mergeTokenlessTwinGateways, reachableAlternateIpv4 } from '@/lib/gateway/candidates';
import type { GatewayProfile } from '@/lib/gateway/types';

// AUTH-1, the roster the operator's phone is left holding: a connect fan-out
// that matched a probe winner by exact URL saved the Gate a SECOND time under
// the address one wave reached it on, with no token — and that copy is usually
// the active one, because it is the copy the connect picked. It then keeps
// winning every wave and connecting anonymously, so the roster is healed once at
// startup: the twin folds into the profile that can authenticate. The pass over
// the real provider lives in gateway-provider-token-fanout-test.tsx; these are
// its two rules, on their own.

const GATE_URL = 'http://ethanspc.tail1234.ts.net:8760';
const TAILNET_IP = '100.95.137.83';
const TAILNET_URL = `http://${TAILNET_IP}:8760`;

const profile = (overrides: Partial<GatewayProfile> & { id: string; url: string }): GatewayProfile => ({
  name: overrides.id,
  kind: 'custom',
  createdAt: 1,
  ...overrides,
});

/** The paired profile and the twin a wave created for it, twin last. */
function poisonedRoster(): GatewayProfile[] {
  return [
    profile({ id: 'paired', url: GATE_URL, token: 't', model: 'kilo/glm-5.3' }),
    profile({ id: 'twin', name: 'Ethanspc', url: TAILNET_URL, sessionKey: 'sk' }),
  ];
}

describe('folding a token-less twin into the profile that can authenticate', () => {
  const evidence = {
    tailscaleHost: TAILNET_IP,
    cachedIpv4ByProfileId: { paired: [TAILNET_IP] },
  };

  test('the paired profile survives with its own id, URL, key and pins, and takes the active id', () => {
    const healed = mergeTokenlessTwinGateways(poisonedRoster(), 'twin', evidence);
    expect(healed.gateways.map((item) => item.id)).toEqual(['paired']);
    expect(healed.gateways[0].url).toBe(GATE_URL);
    expect(healed.gateways[0].token).toBe('t');
    expect(healed.gateways[0].model).toBe('kilo/glm-5.3');
    expect(healed.activeId).toBe('paired');
    expect(healed.idMap).toEqual({ twin: 'paired' });
    expect(healed.changed).toBe(true);
  });

  test('the twin only fills gaps the survivor has none of', () => {
    const [survivor] = mergeTokenlessTwinGateways(poisonedRoster(), 'paired', evidence).gateways;
    expect(survivor.sessionKey).toBe('sk');
    // The twin had no key of its own, so it cannot overwrite the survivor's.
    expect(survivor.token).toBe('t');
  });

  test('the manifest the paired profile cached is evidence on its own', () => {
    const healed = mergeTokenlessTwinGateways(poisonedRoster(), 'twin', {
      cachedIpv4ByProfileId: { paired: [TAILNET_IP] },
    });
    expect(healed.gateways.map((item) => item.id)).toEqual(['paired']);
    expect(healed.activeId).toBe('paired');
  });

  test('two paired candidates for one twin is a guess, so nothing is merged', () => {
    const roster = [
      ...poisonedRoster(),
      profile({ id: 'paired-2', url: 'http://office.tail1234.ts.net:8760', token: 't2', alternateIpv4: [TAILNET_IP] }),
    ];
    const healed = mergeTokenlessTwinGateways(roster, 'twin', evidence);
    expect(healed.changed).toBe(false);
    expect(healed.gateways.map((item) => item.id)).toEqual(['paired', 'twin', 'paired-2']);
  });

  test('a second listener on that host is a different gateway, and stays its own profile', () => {
    const hermes = profile({ id: 'hermes', url: `http://${TAILNET_IP}:8642`, kind: 'hermes' });
    const healed = mergeTokenlessTwinGateways([poisonedRoster()[0], hermes], 'hermes', evidence);
    expect(healed.changed).toBe(false);
  });

  test('an address nothing in the roster can vouch for is not a twin', () => {
    const lanTwin = profile({ id: 'lan', url: 'http://192.168.1.50:8760' });
    const healed = mergeTokenlessTwinGateways([poisonedRoster()[0], lanTwin], 'lan', evidence);
    expect(healed.changed).toBe(false);
    expect(healed.gateways.map((item) => item.id)).toEqual(['paired', 'lan']);
  });

  test('a child profile is never folded into a parent', () => {
    const child = profile({ id: 'paired::openai', url: `${GATE_URL}/p/openai`, parentId: 'paired', kind: undefined });
    const healed = mergeTokenlessTwinGateways([...poisonedRoster(), child], 'twin', evidence);
    expect(healed.gateways.map((item) => item.id).sort()).toEqual(['paired', 'paired::openai']);
  });

  test('a roster with nothing to heal reports no change, so nothing is written', () => {
    const roster = poisonedRoster();
    expect(mergeTokenlessTwinGateways([roster[0]], 'paired', evidence)).toEqual({
      gateways: [roster[0]],
      idMap: {},
      activeId: 'paired',
      changed: false,
    });
  });
});

describe('the address a wave reached a saved gateway on', () => {
  test('becomes an alternate address, not a new URL', () => {
    expect(reachableAlternateIpv4(TAILNET_URL, profile({ id: 'paired', url: GATE_URL }))).toEqual([
      TAILNET_IP,
    ]);
  });

  test('is left out when the profile already knows it, or the port is another service', () => {
    const known = profile({ id: 'paired', url: GATE_URL, alternateIpv4: [TAILNET_IP] });
    expect(reachableAlternateIpv4(TAILNET_URL, known)).toEqual([]);
    expect(reachableAlternateIpv4(`http://${TAILNET_IP}:8642`, profile({ id: 'paired', url: GATE_URL }))).toEqual([]);
    // The winner IS the saved URL: nothing new to remember.
    expect(reachableAlternateIpv4(GATE_URL, profile({ id: 'paired', url: GATE_URL }))).toEqual([]);
  });

  test('keeps the addresses the profile already had', () => {
    const saved = profile({ id: 'paired', url: GATE_URL, alternateIpv4: ['100.64.0.9'] });
    expect(reachableAlternateIpv4(TAILNET_URL, saved)).toEqual(['100.64.0.9', TAILNET_IP]);
  });
});
