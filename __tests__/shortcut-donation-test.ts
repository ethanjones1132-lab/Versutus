import { botChatShortcut } from '@/lib/gateway/shortcuts';
import { createBotShortcutRecorder, RECENT_BOT_SHORTCUTS_KEY } from '@/lib/gateway/shortcut-donation';

describe('recent Bot shortcut donation', () => {
  test('stores at most three unique recent Bots and republishes their existing deep links', async () => {
    let stored = JSON.stringify(['scout', 'nova', 'scout']);
    const storage = {
      getItem: jest.fn(async () => stored),
      setItem: jest.fn(async (_key: string, value: string) => { stored = value; }),
    };
    const updateShortcuts = jest.fn(async (_shortcuts: ReturnType<typeof botChatShortcut>[]) => undefined);
    const remember = createBotShortcutRecorder({ storage, updateShortcuts });

    await remember('nova');

    expect(storage.setItem).toHaveBeenCalledWith(RECENT_BOT_SHORTCUTS_KEY, JSON.stringify(['nova', 'scout']));
    expect(updateShortcuts).toHaveBeenCalledWith([
      botChatShortcut('nova'),
      botChatShortcut('scout'),
    ]);
  });

  test('a storage or native shortcut refusal never rejects recording a chat', async () => {
    const storage = {
      getItem: jest.fn(async () => { throw new Error('storage unavailable'); }),
      setItem: jest.fn(async () => { throw new Error('storage unavailable'); }),
    };
    const updateShortcuts = jest.fn(async () => { throw new Error('native module unavailable'); });
    const remember = createBotShortcutRecorder({ storage, updateShortcuts });

    await expect(remember('scout')).resolves.toEqual(['scout']);
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
    const remember = createBotShortcutRecorder({ storage, updateShortcuts });

    await Promise.all([remember('one'), remember('two'), remember('three'), remember('four')]);

    expect(JSON.parse(stored)).toEqual(['four', 'three', 'two']);
  });
});
