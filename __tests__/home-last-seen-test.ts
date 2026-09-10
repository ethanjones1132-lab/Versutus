jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  LAST_SEEN_KEY_PREFIX,
  clearLastSeen,
  loadLastSeen,
  stampAllLastSeen,
  stampLastSeen,
} from '@/lib/home/last-seen';

describe('stampLastSeen', () => {
  test('writes the timestamp under the gateway-scoped key', async () => {
    await stampLastSeen('gw-1', 1757400000000);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'versutus:last-seen:gw-1',
      '1757400000000',
    );
  });

  test('is a no-op with no gateway to stamp', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await stampLastSeen('', 1);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});

describe('stampAllLastSeen', () => {
  test('stamps every saved gateway for one app-level leave', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await stampAllLastSeen(['gw-1', 'gw-2'], 1757400000000);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      `${LAST_SEEN_KEY_PREFIX}gw-1`,
      '1757400000000',
    );
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      `${LAST_SEEN_KEY_PREFIX}gw-2`,
      '1757400000000',
    );
  });

  test('deduplicates ids so one stamp per gateway', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await stampAllLastSeen(['gw-1', 'gw-1'], 7);
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  });
});

describe('loadLastSeen', () => {
  test('reads back a stamped timestamp', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('1757400000000');
    expect(await loadLastSeen('gw-1')).toBe(1757400000000);
  });

  test('returns null when nothing was ever stamped', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    expect(await loadLastSeen('gw-never')).toBeNull();
  });

  test('returns null on a corrupt rather than guessed value', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-a-number');
    expect(await loadLastSeen('gw-1')).toBeNull();
  });

  test('returns null on zero — epoch is not a visit', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('0');
    expect(await loadLastSeen('gw-1')).toBeNull();
  });
});

describe('clearLastSeen', () => {
  test('removes the gateway-scoped key', async () => {
    await clearLastSeen('gw-1');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('versutus:last-seen:gw-1');
  });
});
