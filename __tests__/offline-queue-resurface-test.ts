// Which queued lines belong on the thread a history reload just painted. The
// durable outbox is held per gateway, but a reply typed on a bot-message notice
// was typed for ONE Bot Chat (src/lib/notifications/bot-reply.ts, ADR 0012), so
// the re-surface must not push it under whichever thread the app happens to be
// showing (FUTURE-ITEMS.md §6, the outbox fallback).

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

import {
  resurfaceOfflineQueue,
  type OfflineQueueItem,
} from '@/lib/gateway/session-persistence';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

/** A queued line; a composer send names no Bot and is what it always was. */
function row(overrides: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: 'item-1',
    text: 'on my way',
    gatewayId: 'gw-1',
    createdAt: 1757400000000,
    ...overrides,
  };
}

/** The configurable chat: this gateway, no Bot Chat open. */
const CONFIGURABLE_CHAT = { gatewayId: 'gw-1', botId: undefined };
/** One Bot's canonical Bot Chat (ADR 0012). */
const SCOUT_CHAT = { gatewayId: 'gw-1', botId: 'scout' };

describe('a re-surface paints only the rows that belong on the thread it loaded', () => {
  test('a row that names no Bot Chat shows wherever the operator is', () => {
    const composerLine = row({ id: 'composer' });

    expect(resurfaceOfflineQueue([composerLine], CONFIGURABLE_CHAT)).toEqual([composerLine]);
    expect(resurfaceOfflineQueue([composerLine], SCOUT_CHAT)).toEqual([composerLine]);
  });

  test('a row whose Bot is the current scope shows', () => {
    const reply = row({ id: 'reply', botId: 'scout', sessionId: 'sess-1' });

    expect(resurfaceOfflineQueue([reply], SCOUT_CHAT)).toEqual([reply]);
  });

  test('a row typed for another Bot Chat is held for that Bot Chat', () => {
    const forScout = row({ id: 'scout-reply', botId: 'scout' });
    const forScribe = row({ id: 'scribe-reply', botId: 'scribe' });

    expect(resurfaceOfflineQueue([forScout, forScribe], SCOUT_CHAT)).toEqual([forScout]);
  });

  test('a Bot Chat row is held when the configurable chat is what loaded', () => {
    const reply = row({ id: 'reply', botId: 'scout' });

    expect(resurfaceOfflineQueue([reply], CONFIGURABLE_CHAT)).toEqual([]);
  });

  test('another gateway is still another thread — the shipped filter survives', () => {
    const here = row({ id: 'here' });
    const elsewhere = row({ id: 'elsewhere', gatewayId: 'gw-2' });
    const elsewhereReply = row({ id: 'elsewhere-reply', gatewayId: 'gw-2', botId: 'scout' });

    expect(resurfaceOfflineQueue([here, elsewhere, elsewhereReply], SCOUT_CHAT)).toEqual([here]);
  });

  test('a mixed queue re-surfaces its own rows in the order they were parked', () => {
    const queue = [
      row({ id: 'a', botId: 'scout' }),
      row({ id: 'b' }),
      row({ id: 'c', botId: 'scribe' }),
      row({ id: 'd', botId: 'scout' }),
      row({ id: 'e', gatewayId: 'gw-2' }),
    ];

    expect(resurfaceOfflineQueue(queue, SCOUT_CHAT).map((item) => item.id)).toEqual(['a', 'b', 'd']);
  });

  test('a legacy row with no destination re-surfaces untouched', () => {
    const legacy: OfflineQueueItem = {
      id: 'old',
      text: 'typed offline',
      gatewayId: 'gw-1',
      createdAt: 7,
    };

    expect(resurfaceOfflineQueue([legacy], SCOUT_CHAT)).toEqual([legacy]);
  });
});

describe('the history reload paints through that filter, and paints what it always did', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
  const RESURFACE = '// Re-surface durable offline outbox items after history reload.';
  const resurface = () => between(provider(), RESURFACE, 'setMessages(boundWindow(merged));');

  test('the pending rows are the pure filter\'s, scoped to the Bot Chat the reload painted', () => {
    const src = resurface();

    expect(src).toContain('resurfaceOfflineQueue(offlineQueueRef.current, {');
    expect(src).toContain('gatewayId: gateway.id,');
    expect(src).toContain('botId: selectedBotIdRef.current,');
    // The gateway-only filter this replaces would put a reply typed for one
    // Bot Chat under another thread's transcript.
    expect(src).not.toContain('filter((item) => item.gatewayId === gateway.id)');
  });

  test('the bubble is the same queued user bubble it always was, and nothing sends', () => {
    const src = resurface();

    expect(src).toContain('id: item.id,');
    expect(src).toContain("role: 'user',");
    expect(src).toContain('text: item.text,');
    expect(src).toContain('timestamp: item.createdAt,');
    expect(src).toContain('queued: true,');
    // Painting the outbox is not a send path: the flush is the only sender.
    expect(src).not.toContain('sendChatInput(');
    expect(src).not.toContain('fetch(');
  });
});
