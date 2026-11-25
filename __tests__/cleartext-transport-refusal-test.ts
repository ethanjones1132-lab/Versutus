import { createClientForKind } from '@/lib/portal/adapters';
import { deepLinkTarget } from '@/lib/gateway/deep-link';
import { cleartextRefusalMessage } from '@/lib/gateway/security';
import { addGatewayProfile, createGatewayProfile, loadGateways } from '@/lib/gateway/storage';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';
import type { GatewayProfile } from '@/lib/gateway/types';

// â”€â”€â”€ One predicate, two paths â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cleartext is for the trusted local network only. The profile save path and
// the request path must reach the same verdict about the same URL, and the
// refusal must name the URL, the host, and the reason â€” it is shown to someone
// who has to decide what to change.

jest.mock('@/lib/storage/secure-key-value', () => ({
  secureKeyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockGet = secureKeyValueStorage.getItem as jest.Mock;
const mockSet = secureKeyValueStorage.setItem as jest.Mock;

const GATEWAYS_KEY = 'versutus:gateways';

const REFUSED = 'http://example.com:8760';

const profile = (
  url: string,
  input: Partial<GatewayProfile> & Pick<GatewayProfile, 'id'> = { id: 'gw-cleartext' },
): GatewayProfile => ({
  name: 'Gate',
  url,
  token: 'gw-fixture',
  createdAt: 1,
  ...input,
});

/** Capture the rejection so the message itself can be compared. */
async function rejectionOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

function syncThrowOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to be refused, but it returned');
}

describe('the profile save path refuses untrusted cleartext', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue(null);
    mockSet.mockReset().mockResolvedValue(undefined);
  });

  test('addGatewayProfile refuses http://example.com and names it', async () => {
    const error = await rejectionOf(() => addGatewayProfile(profile(REFUSED)));
    expect(error.message).toContain(REFUSED);
    expect(error.message).toContain('trusted local network');
    expect(error.message).toBe(cleartextRefusalMessage(REFUSED));
  });

  test('a refused profile is never written to the store', async () => {
    await rejectionOf(() => addGatewayProfile(profile(REFUSED)));
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockGet.mock.calls.some((call) => call[0] === GATEWAYS_KEY)).toBe(false);
  });

  test('createGatewayProfile refuses before a profile object exists', () => {
    const error = syncThrowOf(() => createGatewayProfile({ name: 'Example', url: REFUSED }));
    expect(error.message).toContain(REFUSED);
    expect(error.message).toBe(cleartextRefusalMessage(REFUSED));
  });

  test.each([
    'http://192.168.1.9:5599',
    'http://100.100.1.2:8760',
    'http://box.tail1234.ts.net:8760',
    'http://127.0.0.1:5599',
    'https://example.com',
  ])('accepts %s', async (url) => {
    await expect(addGatewayProfile(profile(url))).resolves.toBeDefined();
  });
});

describe('the request path refuses untrusted cleartext', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('createClientForKind refuses http://example.com before a transport exists', () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const error = syncThrowOf(() => createClientForKind('hermes', profile(REFUSED)));
    expect(error.message).toContain(REFUSED);
    expect(error.message).toBe(cleartextRefusalMessage(REFUSED));
    // No client, no request, and therefore no Bearer header on that origin.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the Bearer header is never attached to a refused origin', async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const error = syncThrowOf(() => createClientForKind('custom', profile(REFUSED), {}, undefined));
    expect(error.message).toContain('example.com');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    'http://192.168.1.9:5599',
    'http://100.100.1.2:8760',
    'http://box.tail1234.ts.net:8760',
    'http://127.0.0.1:5599',
  ])('builds a client for the trusted host %s', (url) => {
    expect(() => createClientForKind('hermes', profile(url))).not.toThrow();
  });

  test('https://example.com still builds', () => {
    expect(() => createClientForKind('hermes', profile('https://example.com'))).not.toThrow();
  });
});

describe('a deep link cannot store a profile the save path refuses', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue(null);
    mockSet.mockReset().mockResolvedValue(undefined);
  });

  test('the add link still prefills a refused address, but the save throws', async () => {
    const target = deepLinkTarget('add', { url: REFUSED });
    expect(target).toEqual({ kind: 'add', params: { url: REFUSED } });
    if (target?.kind !== 'add') throw new Error('expected an add target');

    const error = syncThrowOf(() =>
      createGatewayProfile({ name: 'From link', url: target.params.url, token: 'link-token' }),
    );
    expect(error.message).toContain(REFUSED);
    expect(mockSet).not.toHaveBeenCalled();
    await expect(loadGateways()).resolves.toEqual([]);
  });

  test('a link naming a bracketed IPv6 literal or a lookalike suffix is refused', () => {
    for (const url of ['http://[2001:db8::1]', 'http://notts.net']) {
      expect(cleartextRefusalMessage(url)).not.toBeNull();
      expect(syncThrowOf(() => createGatewayProfile({ name: 'From link', url })).message).toContain(url);
    }
  });
});
