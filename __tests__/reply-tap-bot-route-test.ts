import { routeForTap, type TapRoute } from '@/lib/notifications/tap-route';

// The classifier on the Gate emits `data: { kind: 'reply', sessionId, botId }`
// (gate/core/push-notifier.mjs classifiedEvent) and the router's reply wiring
// lands the session. The Bot is the second half of that payload: these pins
// hold the router to carrying it, and the screen to honoring it only through
// a landed open — never through a bare navigation.

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

const layout = () => readSource('src', 'app', '_layout.tsx');

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the router carries a reply notice's botId beside its session", () => {
  const routerSource = () =>
    between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');

  const openEffect = () =>
    between(
      routerSource(),
      'const replySessionRef = useRef',
      '  // The Approve / Deny buttons only exist once the category is registered',
    );

  test('a reply payload routes WITH its bot, and without one stays botless', () => {
    expect(routeForTap({ kind: 'reply', sessionId: 'session-7', botId: 'scout' }) as TapRoute).toEqual({
      kind: 'reply',
      sessionId: 'session-7',
      botId: 'scout',
    });
    expect(routeForTap({ kind: 'reply', sessionId: 'session-7' })).toEqual({
      kind: 'reply',
      sessionId: 'session-7',
    });
  });

  test('replySessionFor carries the bot beside the session', () => {
    const src = routerSource();

    // The destination drops the ids — Chat is one tab — so both the session and
    // the Bot ride beside it. Dropping the Bot back down to the session alone
    // is what put the operator in the right thread under the wrong name.
    expect(src).toContain(
      'route?.kind === \'reply\'\n        ? { sessionId: route.sessionId, ...(route.botId ? { botId: route.botId } : {}) }\n        : null;',
    );
    expect(src).toContain(
      'const pendingReplySessionRef = useRef<{ sessionId: string; botId?: string } | null>(null);',
    );
  });

  test('the open validates the session first, then opens the Bot, then asks for the surface', () => {
    const src = openEffect();

    // Order is the contract: the id is validated through `session.get` (the
    // proven open-by-id pairing, because a push-delivered id can be stale), a
    // landed open pins the Bot, and the surface request rides ONLY a landed
    // open — the same landed-open rule the deep-link chat path applies.
    expect(src).toContain('openSessionById(gatewayRequest, sessionId)');
    expect(src.indexOf('openSessionById(gatewayRequest, sessionId)')).toBeLessThan(
      src.indexOf('await openBot(botId)'),
    );
    expect(src).toContain('const opened = await openBot(botId)');
    expect(src).toContain("requestSurface({ kind: 'bot', botId })");
    // The ref's shape is the two-argument open, and it stays registered once
    // (both call sites hand the Bot through).
    expect(src).toContain('replySessionRef.current = (sessionId: string, botId?: string) =>');
    expect(
      (routerSource().match(/replySessionRef\.current\?\.\(replySession\.sessionId, replySession\.botId\)/g) ?? [])
        .length,
    ).toBe(2);
  });

  test('a refused Bot open is not a crash: the scope is dropped and the notice says so', () => {
    const src = openEffect();

    // openBot answers rather than throws, so a refusal clears the scope the
    // same way a thrown open does — clearBot returns the scope to configurable
    // chat, exactly what the roster's back out leaves — and the follow-up
    // notice names the truth instead of implying the Bot was reached.
    expect(src).toContain('void clearBot();');
    expect(src).toContain("void notifyBotReplyNotSent('bot-chat-unavailable')");
  });

  test('a routine tap still routes to Chat with no session and no Bot', () => {
    const src = routerSource();
    expect(src).toContain("route?.kind === 'routine'");
    expect(src).not.toContain("kind === 'routine' ? { sessionId");
  });
});
