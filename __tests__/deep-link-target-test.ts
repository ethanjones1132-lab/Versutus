import { deepLinkTarget } from '@/lib/gateway/deep-link';

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

describe('deepLinkTarget (the app link vocabulary)', () => {
  test('an add link carries its params to the add sheet', () => {
    expect(deepLinkTarget('add', { url: 'http://gw.local:8080', token: 'abc' })).toEqual({
      kind: 'add',
      params: { url: 'http://gw.local:8080', token: 'abc' },
    });
  });

  test('both add spellings mean the same thing, slashes and all', () => {
    // `versutus://add?url=…` and `versutus://gateway/add?url=…` are the two
    // links the README and the pairing flow hand out; the leading slashes
    // expo's parser may leave are not part of the vocabulary.
    expect(deepLinkTarget('gateway/add', {})).toEqual({ kind: 'add', params: {} });
    expect(deepLinkTarget('/add', {})).toEqual({ kind: 'add', params: {} });
    expect(deepLinkTarget('//gateway/add', {})).toEqual({ kind: 'add', params: {} });
  });

  test('a repeated param takes its first value, and an empty one is dropped', () => {
    expect(
      deepLinkTarget('add', { url: ['first', 'second'], token: '', missing: undefined }),
    ).toEqual({ kind: 'add', params: { url: 'first' } });
  });

  test('a chat link names the Bot it opens', () => {
    expect(deepLinkTarget('chat', { bot: 'scout' })).toEqual({ kind: 'chat', botId: 'scout' });
    expect(deepLinkTarget('/chat', { bot: 'scout' })).toEqual({ kind: 'chat', botId: 'scout' });
  });

  test('a chat link with no Bot is a no-op, never a guessed thread', () => {
    expect(deepLinkTarget('chat', {})).toBeNull();
    expect(deepLinkTarget('chat', { bot: '' })).toBeNull();
    expect(deepLinkTarget('chat', { bot: '   ' })).toBeNull();
    expect(deepLinkTarget('chat', { bot: undefined })).toBeNull();
  });

  test('the Bot id is trimmed, and a repeated one takes its first value', () => {
    // A link built by hand with padding still names the Bot; a Bot id with
    // surrounding whitespace is the same Bot, not a second one.
    expect(deepLinkTarget('chat', { bot: '  scout  ' })).toEqual({ kind: 'chat', botId: 'scout' });
    expect(deepLinkTarget('chat', { bot: ['scout', 'night'] })).toEqual({
      kind: 'chat',
      botId: 'scout',
    });
  });

  test('a chat link carries the Bot and nothing else', () => {
    expect(deepLinkTarget('chat', { bot: 'scout', url: 'http://gw.local' })).toEqual({
      kind: 'chat',
      botId: 'scout',
    });
  });

  test('every other path is nothing at all', () => {
    expect(deepLinkTarget('settings', { bot: 'scout' })).toBeNull();
    // The vocabulary is case-sensitive and has no trailing-slash spelling:
    // an unrecognized path is a no-op, not a guess at the nearest one.
    expect(deepLinkTarget('CHAT', { bot: 'scout' })).toBeNull();
    expect(deepLinkTarget('chat/', { bot: 'scout' })).toBeNull();
    expect(deepLinkTarget('gateway/spend', {})).toBeNull();
    expect(deepLinkTarget('', {})).toBeNull();
    expect(deepLinkTarget(null, {})).toBeNull();
    expect(deepLinkTarget(undefined, {})).toBeNull();
  });
});

describe('GatewayDeepLinkRouter routes on that target', () => {
  const routerSource = () =>
    between(layout(), 'function GatewayDeepLinkRouter', 'export default function RootLayout');

  test('still waits for bootstrap and handles each url once', () => {
    const src = routerSource();

    // The Stack is not mounted until bootstrap, and a cold-start link used to
    // race the boot overlay's first-run redirect and lose.
    expect(src).toContain('!isBootstrapped');
    expect(src).toContain('handledRef.current === url');
  });

  test('the path decision is the fold\'s, not a literal in the router', () => {
    const src = routerSource();

    expect(src).toContain('deepLinkTarget(parsed.path, parsed.queryParams ?? {})');
    // One rule for what a link means, in a module the cases above can call.
    expect(src).not.toContain("path !== 'add'");
  });

  test('an add link still pushes to the add sheet with its params', () => {
    const src = routerSource();

    expect(src).toContain("pathname: '/gateway/add'");
    expect(src).toContain('params: target.params');
  });

  test('a chat link lands on the Chat tab and opens that Bot Chat', () => {
    const src = routerSource();
    const chat = src.slice(src.indexOf("if (target.kind === 'add')"));

    const navigate = chat.indexOf("router.navigate('/chat')");
    const open = chat.indexOf('openBot(target.botId)');
    const ask = chat.indexOf("requestSurface({ kind: 'bot', botId: target.botId })");
    expect(navigate).toBeGreaterThan(-1);
    // The open resolves the Bot's canonical Bot Chat (ADR 0012) and the screen
    // is asked to follow it: the provider reloads the transcript, but the
    // surface it shows is the screen's own state.
    expect(open).toBeGreaterThan(navigate);
    expect(ask).toBeGreaterThan(open);
  });

  test('an open that fails falls back to the roster, never a bot surface', () => {
    const src = routerSource();
    const chat = src.slice(src.indexOf("if (target.kind === 'add')"));

    // The same landing a failed roster tap takes: the operator reads the Bot
    // list rather than a header naming a thread that never opened.
    expect(chat).toContain("requestSurface({ kind: 'roster' })");
  });

  test('the Bot surface is asked for only on a landed open, the roster on a refusal', () => {
    const src = routerSource();
    const chat = src.slice(src.indexOf("if (target.kind === 'add')"));

    // `openBot` answers whether it opened. A gateway whose client cannot scope
    // Bots REFUSES rather than throwing, and nothing may be asked for off that
    // non-answer — the link would otherwise claim a Bot Chat the app never
    // opened, over whatever thread the provider still holds.
    expect(chat).toContain('.then((opened) => {');

    const refusal = chat.slice(
      chat.indexOf('if (!opened) {'),
      chat.indexOf("requestSurface({ kind: 'bot', botId: target.botId })"),
    );

    expect(refusal).toContain("requestSurface({ kind: 'roster' })");
    expect(refusal).toContain('return;');
  });

  test('the connection is checked before the link is consumed', () => {
    const src = routerSource();
    // Everything after the add push is the chat branch — the add link needs no
    // connection, and its own mark is the one before this cut.
    const chat = src.slice(src.indexOf('params: target.params'));

    const gate = chat.indexOf("status !== 'connected'");
    const mark = chat.indexOf('handledRef.current = url');
    expect(gate).toBeGreaterThan(-1);
    // A link that lands while the connection is still coming up is not marked
    // handled, so it is answered once the gateway is there — and on a device
    // with no gateway nothing opens, leaving the first-run redirect to decide
    // where the operator lands.
    expect(mark).toBeGreaterThan(gate);
  });

  test('the focus the link asks for rides behind the landed open, and it never sends', () => {
    const src = routerSource();

    // FUTURE-ITEMS item 8 asks for the Bot Chat "with the composer focused".
    // The request names the Bot the open resolved and sits inside the branch
    // that open lands in — the screen, not the router, decides where it can be
    // honoured — and a link never sends what it carries.
    const open = src.indexOf('openBot(target.botId)');
    const focus = src.indexOf('requestComposerFocus({ botId: target.botId })');
    expect(open).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(open);
    expect(src).toContain('requestComposerFocus,');
    expect(src).not.toContain('sendChatInput');
  });
});
