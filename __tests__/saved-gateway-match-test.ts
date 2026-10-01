import { matchSavedGateway } from '@/lib/gateway/candidates';
import type { GatewayProfile } from '@/lib/gateway/types';

// AUTH-1: a probe winner was matched to a saved profile by exact URL only, so
// the same Gate reached under a second host form — the MagicDNS name while its
// tailnet IP answers — became a brand-new profile with no token. Its connect
// fan-out then went out with no Authorization, and the Gate answered 401.

const GATE_URL = 'http://ethanspc.tail1234.ts.net:8760';
const TAILNET_IP = '100.95.137.83';

function profile(overrides: Partial<GatewayProfile> & { id: string; url: string }): GatewayProfile {
  return {
    name: overrides.id,
    kind: 'custom',
    token: 't',
    createdAt: 0,
    ...overrides,
  } as GatewayProfile;
}

describe('a probe winner that is a saved Gate under another host form', () => {
  test('the tailnet IP the Gate advertised resolves to the saved MagicDNS profile', () => {
    const saved = [profile({ id: 'alpha', url: GATE_URL })];
    const match = matchSavedGateway(`http://${TAILNET_IP}:8760`, saved, {
      cachedIpv4ByProfileId: { alpha: [TAILNET_IP] },
    });
    expect(match).toBe(saved[0]);
    expect(match?.token).toBe('t');
  });

  test('an IPv4 the profile already knew as its own alternate resolves too', () => {
    const saved = [profile({ id: 'alpha', url: GATE_URL, alternateIpv4: [TAILNET_IP] })];
    expect(matchSavedGateway(`http://${TAILNET_IP}:8760`, saved)).toBe(saved[0]);
  });

  test('the configured tailscaleHost resolves the active Gate profile with no manifest to lean on', () => {
    const saved = [profile({ id: 'alpha', url: GATE_URL })];
    expect(
      matchSavedGateway(`http://${TAILNET_IP}:8760`, saved, {
        tailscaleHost: TAILNET_IP,
        activeId: 'alpha',
      }),
    ).toBe(saved[0]);
  });

  test('the configured host does not adopt a Gate profile this device never used', () => {
    const saved = [
      profile({ id: 'alpha', url: GATE_URL }),
      profile({ id: 'beta', url: 'http://other.tail1234.ts.net:8760' }),
    ];
    // Two Gate profiles on the port and neither of them the one this device
    // last used: the configured host says nothing about which one this is.
    expect(matchSavedGateway(`http://${TAILNET_IP}:8760`, saved, { tailscaleHost: TAILNET_IP })).toBeUndefined();
    // The one it did use is the operator's answer, and it is matched.
    expect(
      matchSavedGateway(`http://${TAILNET_IP}:8760`, saved, { tailscaleHost: TAILNET_IP, activeId: 'beta' }),
    ).toBe(saved[1]);
  });

  test('a second listener on one host is a different service', () => {
    // Gate :8760 and Hermes :8642 are both probed from one tailnet IP. Borrowing
    // the Gate's token for :8642 would earn the very 401 this exists to avoid.
    const saved = [profile({ id: 'alpha', url: GATE_URL, alternateIpv4: [TAILNET_IP] })];
    expect(
      matchSavedGateway(`http://${TAILNET_IP}:8642`, saved, {
        cachedIpv4ByProfileId: { alpha: [TAILNET_IP] },
      }),
    ).toBeUndefined();
  });

  test('a provider child profile is never matched — it follows its parent', () => {
    const saved = [
      profile({ id: 'alpha', url: GATE_URL }),
      profile({
        id: 'alpha::openai',
        url: `${GATE_URL}/p/openai`,
        parentId: 'alpha',
        token: undefined,
      }),
    ];
    expect(
      matchSavedGateway(`${GATE_URL}/p/openai`, saved, { cachedIpv4ByProfileId: { alpha: [TAILNET_IP] } }),
    ).toBeUndefined();
  });

  test('the profile that can authenticate wins over a token-less twin at the same rank', () => {
    const saved = [
      profile({ id: 'tokenless', url: `http://${TAILNET_IP}:8760`, token: undefined }),
      profile({ id: 'alpha', url: GATE_URL }),
    ];
    expect(
      matchSavedGateway(`http://${TAILNET_IP}:8760`, saved, {
        cachedIpv4ByProfileId: { alpha: [TAILNET_IP], tokenless: [TAILNET_IP] },
      }),
    ).toBe(saved[1]);
  });

  test('a token-less copy saved on that port does not hide the profile that can authenticate', () => {
    // The roster this bug leaves behind: the Gate saved twice on one port, the
    // second copy without a key. It cannot be the Gateway this device is paired
    // with, so it must not make the match ambiguous — and it must not win.
    const saved = [
      profile({ id: 'alpha', url: GATE_URL }),
      profile({ id: 'twin', url: `http://${TAILNET_IP}:8760`, token: undefined }),
    ];
    expect(
      matchSavedGateway(`http://${TAILNET_IP}:8760`, saved, { tailscaleHost: TAILNET_IP, activeId: 'twin' }),
    ).toBe(saved[0]);
  });

  test('a gateway nobody has saved is still new', () => {
    const saved = [profile({ id: 'alpha', url: GATE_URL })];
    expect(
      matchSavedGateway('http://192.168.1.50:8760', saved, {
        cachedIpv4ByProfileId: { alpha: [TAILNET_IP] },
        tailscaleHost: TAILNET_IP,
      }),
    ).toBeUndefined();
  });
});
