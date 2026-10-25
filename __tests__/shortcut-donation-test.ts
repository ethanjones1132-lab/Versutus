import { botChatShortcut } from '@/lib/gateway/shortcuts';
import type { AppShortcut } from '@/lib/gateway/shortcuts';
import {
  clearRecentBotShortcutsForGateway,
  createBotShortcutRecorder,
  RECENT_BOT_SHORTCUTS_KEY,
} from '@/lib/gateway/shortcut-donation';
import {
  applyRecentBotShortcutsNative,
  type ShortcutNativeModule,
} from '@/lib/gateway/shortcut-donation-native';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
  },
}));

type StoredLedger = {
  gateways: Record<string, string[]>;
  publishedGatewayId: string | null;
};

function ledgerOf(raw: string): StoredLedger {
  return JSON.parse(raw) as StoredLedger;
}

function makeRecorder(initial: string | null = null) {
  let stored = initial;
  const storage = {
    getItem: jest.fn(async () => stored),
    setItem: jest.fn(async (_key: string, value: string) => {
      stored = value;
    }),
  };
  const updateShortcuts = jest.fn(async (_shortcuts: AppShortcut[]) => undefined);
  const recorder = createBotShortcutRecorder({ storage, updateShortcuts });
  return {
    recorder,
    storage,
    updateShortcuts,
    read: () => {
      if (stored === null) throw new Error('nothing stored');
      return ledgerOf(stored);
    },
  };
}

describe('recent Bot shortcut donation', () => {
  test('stores recents per gateway and republishes their existing deep links', async () => {
    const { recorder, storage, updateShortcuts, read } = makeRecorder(
      JSON.stringify({
        gateways: { 'gw-home': ['scout'] },
        publishedGatewayId: 'gw-home',
      }),
    );

    await recorder.register('gw-home', 'nova');

    expect(storage.setItem).toHaveBeenCalledWith(
      RECENT_BOT_SHORTCUTS_KEY,
      JSON.stringify({
        gateways: { 'gw-home': ['nova', 'scout'] },
        publishedGatewayId: 'gw-home',
      }),
    );
    expect(read().gateways['gw-home']).toEqual(['nova', 'scout']);
    expect(updateShortcuts).toHaveBeenCalledWith([
      botChatShortcut('nova'),
      botChatShortcut('scout'),
    ]);
  });

  test('a legacy bare map still reads as per-gateway recents', async () => {
    const { recorder, updateShortcuts, read } = makeRecorder(
      JSON.stringify({ 'gw-home': ['scout'] }),
    );

    await recorder.refresh('gw-home');

    expect(read().gateways).toEqual({ 'gw-home': ['scout'] });
    expect(updateShortcuts).toHaveBeenCalledWith([botChatShortcut('scout')]);
  });

  test('unreadable stored recents read as none rather than guessing', async () => {
    const { recorder, updateShortcuts } = makeRecorder('not json');

    await recorder.refresh('gw-home');

    expect(updateShortcuts).toHaveBeenCalledWith([]);
  });

  test('a storage or native shortcut refusal never rejects recording a chat', async () => {
    const storage = {
      getItem: jest.fn(async () => {
        throw new Error('storage unavailable');
      }),
      setItem: jest.fn(async () => {
        throw new Error('storage unavailable');
      }),
    };
    const updateShortcuts = jest.fn(async () => {
      throw new Error('native module unavailable');
    });
    const recorder = createBotShortcutRecorder({ storage, updateShortcuts });

    await expect(recorder.register('gw-home', 'scout')).resolves.toEqual(['scout']);
    expect(updateShortcuts).toHaveBeenCalledWith([botChatShortcut('scout')]);
  });

  test('simultaneous use records are serialized so the latest three are not lost', async () => {
    let stored = '[]';
    const storage = {
      getItem: jest.fn(async () => stored),
      setItem: jest.fn(async (_key: string, value: string) => {
        await Promise.resolve();
        stored = value;
      }),
    };
    const updateShortcuts = jest.fn(async () => undefined);
    const recorder = createBotShortcutRecorder({ storage, updateShortcuts });

    await Promise.all([
      recorder.register('gw-home', 'one'),
      recorder.register('gw-home', 'two'),
      recorder.register('gw-home', 'three'),
      recorder.register('gw-home', 'four'),
    ]);

    expect(ledgerOf(stored).gateways['gw-home']).toEqual(['four', 'three', 'two']);
  });

  test('registering the same Bot again does not duplicate it', async () => {
    const { recorder, read, updateShortcuts } = makeRecorder();

    await recorder.register('gw-home', 'scout');
    await recorder.register('gw-home', 'scout');
    await recorder.register('gw-home', 'scout');

    expect(read().gateways['gw-home']).toEqual(['scout']);
    expect(updateShortcuts).toHaveBeenLastCalledWith([botChatShortcut('scout')]);
  });

  test('a missing Bot id donates nothing rather than a placeholder link', async () => {
    const { recorder, updateShortcuts, storage } = makeRecorder('[]');

    await expect(recorder.register('gw-home', '   ')).resolves.toEqual([]);
    await expect(recorder.register('   ', 'scout')).resolves.toEqual([]);

    expect(updateShortcuts).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('a zero launcher limit stores and publishes no shortcuts', async () => {
    let stored = '[]';
    const storage = {
      getItem: jest.fn(async () => stored),
      setItem: jest.fn(async (_key: string, value: string) => {
        stored = value;
      }),
    };
    const updateShortcuts = jest.fn(async () => undefined);
    const recorder = createBotShortcutRecorder({ storage, updateShortcuts, limit: 0 });

    await expect(recorder.register('gw-home', 'scout')).resolves.toEqual([]);

    expect(ledgerOf(stored).gateways['gw-home']).toEqual([]);
    expect(updateShortcuts).toHaveBeenCalledWith([]);
  });

  test('refresh with no gateway publishes the empty set and clears the launcher', async () => {
    const { recorder, updateShortcuts, storage } = makeRecorder();
    await recorder.register('gw-home', 'scout');
    updateShortcuts.mockClear();
    storage.setItem.mockClear();

    await expect(recorder.refresh(null)).resolves.toEqual([]);

    expect(updateShortcuts).toHaveBeenCalledWith([]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  test('a fresh install publishes the empty set without creating a storage blob', async () => {
    const { recorder, updateShortcuts, storage } = makeRecorder();

    await expect(recorder.refresh(null)).resolves.toEqual([]);

    expect(updateShortcuts).toHaveBeenCalledWith([]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('one gateway never publishes another gateway’s recents', async () => {
    const { recorder, read, updateShortcuts } = makeRecorder();

    await recorder.register('gw-home', 'scout');
    await recorder.register('gw-other', 'lab');

    // The storage keeps both partitions...
    expect(read().gateways).toEqual({ 'gw-home': ['scout'], 'gw-other': ['lab'] });
    // ...but the launcher only ever sees the gateway whose send published it.
    expect(updateShortcuts).toHaveBeenLastCalledWith([botChatShortcut('lab')]);
    expect(updateShortcuts).not.toHaveBeenLastCalledWith(
      expect.arrayContaining([botChatShortcut('scout'), botChatShortcut('lab')]),
    );

    await recorder.refresh('gw-home');
    expect(updateShortcuts).toHaveBeenLastCalledWith([botChatShortcut('scout')]);
  });

  test('clear forgets a published gateway and empties the native shortcut list', async () => {
    const { recorder, read, updateShortcuts } = makeRecorder();
    await recorder.register('gw-home', 'scout');
    updateShortcuts.mockClear();

    await recorder.clear('gw-home');

    expect(read().gateways['gw-home']).toBeUndefined();
    expect(read().publishedGatewayId).toBeNull();
    expect(updateShortcuts).toHaveBeenCalledWith([]);

    // Clearing again is idempotent: the launcher is told the same empty set.
    updateShortcuts.mockClear();
    await expect(recorder.clear('gw-home')).resolves.toBeUndefined();
    expect(updateShortcuts).toHaveBeenCalledWith([]);
  });

  test('clearing a gateway that is not published leaves the launcher on the active one', async () => {
    const { recorder, updateShortcuts } = makeRecorder();
    await recorder.register('gw-home', 'scout');
    await recorder.register('gw-other', 'lab');
    updateShortcuts.mockClear();

    await recorder.clear('gw-home');

    expect(updateShortcuts).toHaveBeenLastCalledWith([botChatShortcut('lab')]);
    await recorder.refresh();
    expect(updateShortcuts).toHaveBeenLastCalledWith([botChatShortcut('lab')]);
  });

  test('a refused native clear still settles, so a gateway retirement can finish', async () => {
    const { recorder, read, updateShortcuts } = makeRecorder();
    await recorder.register('gw-home', 'scout');
    updateShortcuts.mockRejectedValue(new Error('native module unavailable'));

    await expect(recorder.clear('gw-home')).resolves.toBeUndefined();

    expect(read().gateways['gw-home']).toBeUndefined();
    expect(read().publishedGatewayId).toBeNull();
  });

  test('the retirement clear uses the shared recorder and always settles', async () => {
    // This is the fourth store `clearRetiredGatewayStores` awaits: a refused or
    // empty clear must still resolve so the retire behind it runs.
    await expect(clearRecentBotShortcutsForGateway('gw-retired')).resolves.toBeUndefined();
  });

  test('an empty publication still reaches the native module so dynamic shortcuts clear', async () => {
    const setShortcuts = jest.fn(async () => true);
    const module = { setShortcuts } as unknown as ShortcutNativeModule;

    await expect(applyRecentBotShortcutsNative([], async () => module)).resolves.toBe(true);

    expect(setShortcuts).toHaveBeenCalledWith([]);
  });
});
