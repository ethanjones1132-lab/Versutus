import { reconcileChildProfiles } from '@/lib/gateway/child-sync';
import type { GatewayProfile } from '@/lib/gateway/types';

// `storage.ts` imports the AsyncStorage-backed store while this module loads,
// and secure storage pulls a native module the suite has no handle for — the
// same mocks `child-sync-test.ts` installs.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

jest.mock('@/lib/storage/secure-key-value', () => ({
  secureKeyValueStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

const PARENT: GatewayProfile = {
  id: 'gw-parent',
  name: 'My Gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 't',
  createdAt: 1000,
};

test('reconcileChildProfiles reports only the retirements it decides', () => {
  // The old contract took a providers argument it never read and returned an
  // always-empty `toUpsert`, inventing a create path that does not exist.
  const result = reconcileChildProfiles(PARENT, [PARENT]);
  expect(result).toEqual({ toRemove: [] });
});
