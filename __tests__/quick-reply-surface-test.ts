import { pendingSurface, surfaceKey } from '@/lib/gateway/surface-request';

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

const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
const screen = () => readSource('src', 'components', 'chat', 'chat-screen.tsx');
const layout = () => readSource('src', 'app', '_layout.tsx');

/** The module-level reply helper — where `openBot` lands. */
const delivery = () =>
  between(layout(), 'async function deliverBotReply', 'function NotificationRouter');

/** The shared gateway value every consumer of the context reads. */
const contextValue = () =>
  between(provider(), 'const value = useMemo<GatewayContextValue>(', 'const chatSurfaceValue');

describe('surfaceKey (which surface a request names)', () => {
  test('each kind keys to itself, and the two ids carry their kind', () => {
    // A Bot's id and a group's id are unrelated identifiers: the prefix is what
    // keeps a group room from reading as a Bot Chat.
    expect(surfaceKey({ kind: 'roster' })).toBe('roster');
    expect(surfaceKey({ kind: 'configurable' })).toBe('configurable');
    expect(surfaceKey({ kind: 'bot', botId: 'scout' })).toBe('bot:scout');
    expect(surfaceKey({ kind: 'group', groupId: 'a:b' })).not.toBe(surfaceKey({ kind: 'bot', botId: 'a:b' }));
  });

  test('roster and configurable are different surfaces, not "the non-Bot one"', () => {
    expect(surfaceKey({ kind: 'roster' })).not.toBe(surfaceKey({ kind: 'configurable' }));
  });

  test('two Bots are two surfaces', () => {
    expect(surfaceKey({ kind: 'bot', botId: 'scout' })).not.toBe(surfaceKey({ kind: 'bot', botId: 'coder' }));
  });
});

describe('pendingSurface (the fold the provider holds the request in)', () => {
  test('a request with nothing pending is the pending request', () => {
    expect(pendingSurface(null, { kind: 'bot', botId: 'scout' })).toEqual({ kind: 'bot', botId: 'scout' });
  });

  test('a later request replaces an earlier one that was never consumed', () => {
    // Two replies in a row open two Bot Chats; the transcript the provider now
    // holds is the second one's, so the screen must follow the second.
    expect(pendingSurface({ kind: 'bot', botId: 'scout' }, { kind: 'bot', botId: 'coder' })).toEqual({
      kind: 'bot',
      botId: 'coder',
    });
    expect(pendingSurface({ kind: 'bot', botId: 'scout' }, { kind: 'group', groupId: 'room-1' })).toEqual({
      kind: 'group',
      groupId: 'room-1',
    });
  });

  test('re-requesting the surface already pending keeps the value, so nothing re-fires', () => {
    const pending = { kind: 'bot', botId: 'scout' } as const;

    expect(pendingSurface(pending, { kind: 'bot', botId: 'scout' })).toBe(pending);
  });

  test('the same kind with a different id is a different surface', () => {
    const pending = { kind: 'group', groupId: 'room-1' } as const;

    expect(pendingSurface(pending, { kind: 'group', groupId: 'room-2' })).toEqual({
      kind: 'group',
      groupId: 'room-2',
    });
  });
});

describe('the pending surface is provider-owned', () => {
  test('the request is held on the gateway context and cleared by its consumer', () => {
    const src = provider();

    // Held in the provider, not in the screen: a reply can land while the Chat
    // tab is unmounted, and the screen would lose it.
    expect(src).toContain('const [requestedSurface, setRequestedSurface] = useState<ChatSurface | null>(null);');
    expect(src).toContain('setRequestedSurface((prev) => pendingSurface(prev, surface));');
    expect(src).toContain('requestedSurface: ChatSurface | null;');
    expect(src).toContain('requestSurface: (surface: ChatSurface) => void;');
    expect(src).toContain('clearRequestedSurface: () => void;');
  });

  test('the value memo hands the request, its setter and its clear to every consumer', () => {
    const value = contextValue();

    expect(value).toContain('requestedSurface,');
    expect(value).toContain('requestSurface,');
    expect(value).toContain('clearRequestedSurface,');
  });
});

describe('the chat screen applies the requested surface and clears it', () => {
  test('the screen reads the request off the gateway context', () => {
    const src = screen();

    expect(src).toContain('requestedSurface,');
    expect(src).toContain('clearRequestedSurface,');
  });

  test('it moves the surface through showSurface, then clears the request', () => {
    const src = screen();
    const apply = src.indexOf('showSurface(requestedSurface)');
    const clear = src.indexOf('clearRequestedSurface()');

    expect(apply).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(apply);
    // Cleared exactly once, and never before it was applied — a clear ahead of
    // the apply would drop the request the screen never showed.
    expect(src.indexOf('clearRequestedSurface()', clear + 1)).toBe(-1);
  });

  test('the surface is written on a tick, not from the effect body', () => {
    const effect = between(screen(), 'if (!requestedSurface) return undefined;', 'clearRequestedSurface();');

    // Every producer in this repo defers: writing state straight from an effect
    // body trips react-hooks/set-state-in-effect.
    expect(effect).toContain('setTimeout(() => {');
    expect(effect).toContain('showSurface(requestedSurface)');
  });

  test('a consumed request does not re-apply on later renders', () => {
    // The effect keys on the pending value alone; the clear is what ends it.
    expect(screen()).toContain('}, [requestedSurface, showSurface, clearRequestedSurface]);');
  });
});

describe('a quick reply asks for the Bot Chat it just opened', () => {
  test('the request rides the send path the listener holds in a ref', () => {
    expect(layout()).toContain('replySenderRef.current = { openBot, sendChatInput, requestSurface }');
  });

  test('the request names the reply Bot and comes after the open lands', () => {
    const src = delivery();
    const open = src.indexOf('await sender.openBot(reply.botId)');
    const request = src.indexOf("sender.requestSurface({ kind: 'bot', botId: reply.botId })");
    const send = src.indexOf('sender.sendChatInput(reply.text)');

    expect(open).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(open);
    // Ahead of the send: the surface has to name the thread the text lands in.
    expect(send).toBeGreaterThan(request);
  });

  test('a Bot Chat that did not open asks for nothing', () => {
    const src = delivery();
    const request = src.indexOf('sender.requestSurface(');

    expect(request).toBeGreaterThan(-1);
    // Exactly one request, inside the connection-gated block that holds the
    // open — so a reply parked in the outbox while offline never moves the
    // screen onto a Bot Chat the client did not switch to.
    expect(src.indexOf('sender.requestSurface(', request + 1)).toBe(-1);
    expect(between(src, 'if (decisionCanReachGateway(status)) {', 'const outcome =')).toContain(
      'sender.requestSurface({ kind: \'bot\', botId: reply.botId })',
    );
  });
});
