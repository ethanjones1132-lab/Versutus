// ─── The chat a Bot reopens (VS-129) ────────────────────────────────────────
// A CLI backend retitles a session from its first prompt, so the `Bot Chat`
// title a Bot's chat is created with is gone after the first turn and opening
// the Bot created a fresh conversation on every launch. The device remembers
// the session id per (gateway, Bot) instead; this file pins that store, and the
// wiring that reads and writes it in the provider.
//
// Evidence: A54 2026-11-17 — the Claude Code Bot's chat was session
// 6ea7f382-…; after a reinstall/relaunch the Bot came up empty and the next
// call used a NEW session 3f389930-…

// The pins are storage-backed in the app; these tests own the store.
jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

import { composerDraftKey, composerDraftThread } from '@/lib/gateway/composer-draft';
import { ensureBotChat } from '@/lib/gateway/bots';
import {
  BOT_CHAT_PINS_KEY,
  botChatPinKey,
  botChatPinsFromUnknown,
  loadBotChatPins,
  readBotChatPin,
  saveBotChatPins,
  writeBotChatPin,
} from '@/lib/gateway/thread-session-pins';

import { keyValueStorage } from '@/lib/storage/key-value';

declare const __dirname: string;

const store = keyValueStorage as unknown as {
  getItem: jest.Mock;
  setItem: jest.Mock;
  removeItem: jest.Mock;
};

/** What a relaunched app comes back to: the same durable key/value store. */
const durable = new Map<string, string>();

beforeEach(() => {
  durable.clear();
  store.getItem.mockReset().mockImplementation(async (key: string) => durable.get(key) ?? null);
  store.setItem
    .mockReset()
    .mockImplementation(async (key: string, value: string) => {
      durable.set(key, value);
    });
  store.removeItem.mockReset().mockImplementation(async (key: string) => {
    durable.delete(key);
  });
});

const claude = { gatewayId: 'gw-home', botId: 'claude-code' };
const forge = { gatewayId: 'gw-home', botId: 'forge' };

describe('the chat each Bot reopens is remembered on this device', () => {
  test('it is filed under the Bot’s own thread key, never a shared one', () => {
    expect(botChatPinKey(claude)).toBe(
      composerDraftKey(
        composerDraftThread({
          gatewayId: 'gw-home',
          surface: { kind: 'bot', botId: 'claude-code' },
          sessionId: undefined,
        })!,
      ),
    );
    // Off a Bot surface there is no chat to remember: the configurable thread
    // is not a Bot and must never answer for one.
    expect(botChatPinKey({ gatewayId: 'gw-home' })).toBeUndefined();
    expect(readBotChatPin(writeBotChatPin({}, { gatewayId: 'gw-home' }, 'ses-c'), { gatewayId: 'gw-home' }))
      .toBeUndefined();
  });

  test('the remembered id is read back as the Bot’s chat', () => {
    const pins = writeBotChatPin({}, claude, '6ea7f382-aaaa');
    expect(readBotChatPin(pins, claude)).toBe('6ea7f382-aaaa');
    // Nothing remembered yet is not a chat.
    expect(readBotChatPin({}, claude)).toBeUndefined();
    expect(readBotChatPin({ 'gw-home:bot:claude-code:': '   ' }, claude)).toBeUndefined();
  });

  test('two Bots keep separate chats', () => {
    let pins = writeBotChatPin({}, claude, 'ses-claude');
    pins = writeBotChatPin(pins, forge, 'ses-forge');
    expect(readBotChatPin(pins, claude)).toBe('ses-claude');
    expect(readBotChatPin(pins, forge)).toBe('ses-forge');
    // Replacing one leaves the other exactly where it was.
    pins = writeBotChatPin(pins, claude, 'ses-claude-2');
    expect(readBotChatPin(pins, claude)).toBe('ses-claude-2');
    expect(readBotChatPin(pins, forge)).toBe('ses-forge');
    // Same Bot on another gateway is another chat.
    expect(readBotChatPin(pins, { gatewayId: 'gw-office', botId: 'claude-code' })).toBeUndefined();
  });

  test('a deliberate New session replaces the remembered chat', () => {
    const first = writeBotChatPin({}, claude, '6ea7f382-aaaa');
    const second = writeBotChatPin(first, claude, '3f389930-bbbb');
    expect(readBotChatPin(second, claude)).toBe('3f389930-bbbb');
  });

  test('the pin survives a provider remount because it is in storage', async () => {
    const pins = writeBotChatPin({}, claude, '6ea7f382-aaaa');
    await saveBotChatPins(pins);
    expect(store.setItem).toHaveBeenCalledWith(BOT_CHAT_PINS_KEY, JSON.stringify(pins));

    // A fresh mount reads the durable store, not anything held in memory.
    const remounted = await loadBotChatPins();
    expect(readBotChatPin(remounted, claude)).toBe('6ea7f382-aaaa');
    expect(readBotChatPin(remounted, forge)).toBeUndefined();

    // And the first open after that mount reopens the chat even though the
    // backend has since renamed the session after its first prompt.
    const created: string[] = [];
    const chat = await ensureBotChat(
      [{ id: '6ea7f382-aaaa', title: 'So... We’ll be right back.' }],
      async (title) => {
        created.push(title);
        return { id: 'fresh', title };
      },
      { id: readBotChatPin(remounted, claude) },
    );
    expect(chat.id).toBe('6ea7f382-aaaa');
    expect(created).toEqual([]);
  });

  test('junk in the store is not a remembered chat, and a refusal is an empty store', async () => {
    expect(botChatPinsFromUnknown({ 'gw-home:bot:a:': 'ses-a', other: 42, blank: '  ' }))
      .toEqual({ 'gw-home:bot:a:': 'ses-a' });
    expect(botChatPinsFromUnknown('not an object')).toEqual({});
    expect(botChatPinsFromUnknown(null)).toEqual({});

    // An unreadable store must not throw an open, and a refused write must not
    // throw either: both cost only the convenience of the memory.
    store.getItem.mockRejectedValueOnce(new Error('storage locked'));
    await expect(loadBotChatPins()).resolves.toEqual({});
    store.setItem.mockRejectedValueOnce(new Error('storage locked'));
    await expect(saveBotChatPins({ 'gw-home:bot:a:': 'ses-a' })).resolves.toBeUndefined();
  });
});

describe('the wiring that remembers and reopens the chat', () => {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  const SEP = __dirname.includes('\\') ? '\\' : '/';
  const provider = nodeFs
    .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');

  const openBot = provider.slice(
    provider.indexOf('const openBot = useCallback('),
    provider.indexOf('  useEffect(() => {\n    repairStalePinRef'),
  );
  const createNewSession = provider.slice(
    provider.indexOf('const createNewSession = useCallback('),
    provider.indexOf('useEffect(() => {\n    createNewSessionRef.current = createNewSession;'),
  );
  const adoptThreadSession = provider.slice(
    provider.indexOf('const adoptThreadSession = useCallback('),
    provider.indexOf('/** A pin is spent once it is read'),
  );

  test('a mount loads the remembered chats before any open can ask', () => {
    expect(provider).toContain('botChatPinsReadyRef.current = loadBotChatPins().then((stored) => {');
    expect(provider).toContain('botChatPinsRef.current = { ...stored, ...botChatPinsRef.current };');
    // A first open waits for that one read instead of falling back to a title
    // the backend has renamed.
    expect(openBot).toContain('await botChatPinsReadyRef.current;');
    expect(openBot.indexOf('await botChatPinsReadyRef.current;')).toBeLessThan(
      openBot.indexOf('resetSessionSelector();'),
    );
  });

  test('openBot asks for the remembered chat before the title match', () => {
    expect(openBot).toContain(
      'readBotChatPin(botChatPinsRef.current, { gatewayId, botId })',
    );
    // The title match is still there for a first open and for a remembered id
    // that is truly gone, but the remembered id is offered to the same call.
    expect(openBot).toMatch(/const remembered = gatewayId\s*\n\s*\? readBotChatPin/);
    expect(openBot).toContain('id: remembered,');
    // A partial or failed list may be asked for the id directly, scoped to the
    // Bot so another Bot's session can never answer.
    expect(openBot).toContain("client.rpcRequest('session.get', { sessionId, bot: botId })");
    expect(openBot).toContain('botChatReadSession<HermesSession>(raw, sessionId)');
    // Settling on a chat writes it, after the stale-open guard.
    expect(openBot.indexOf('if (!chat || !isCurrent()) return false;')).toBeLessThan(
      openBot.indexOf('rememberBotChat({ gatewayId, botId }, chat.id)'),
    );
  });

  test('New session replaces the remembered chat, and adoption records it', () => {
    expect(createNewSession).toContain(
      'rememberBotChat({ gatewayId: threadScope, botId: threadBot }, created.id)',
    );
    expect(adoptThreadSession).toContain('rememberBotChat(thread, wanted)');
    // Adoption only writes for a Bot surface; a session adopted in the
    // configurable thread belongs to no Bot.
    expect(adoptThreadSession).toContain('if (thread?.botId) rememberBotChat(thread, wanted);');
  });
});
