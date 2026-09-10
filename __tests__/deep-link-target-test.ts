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

  test('a compose link carries the shared text, and the Bot only when it names one', () => {
    // Item 5's internal handoff: the share sheet's own link. The text rides
    // into the composer's draft, addressed to a Bot when the link names one
    // and to the Chat tab's own surface when it does not.
    expect(deepLinkTarget('compose', { text: 'look at this', bot: 'scout' })).toEqual({
      kind: 'compose',
      text: 'look at this',
      botId: 'scout',
    });
    expect(deepLinkTarget('compose', { text: 'look at this' })).toEqual({
      kind: 'compose',
      text: 'look at this',
    });
    expect(deepLinkTarget('/compose', { text: 'hi', bot: 'scout' })).toEqual({
      kind: 'compose',
      text: 'hi',
      botId: 'scout',
    });
  });

  test('a compose link with nothing to prefill is a no-op', () => {
    // Nothing to put in the draft is nothing to do — the rule a `chat` link
    // with no Bot already follows. A Bot does not make it mean something.
    expect(deepLinkTarget('compose', {})).toBeNull();
    expect(deepLinkTarget('compose', { text: '' })).toBeNull();
    expect(deepLinkTarget('compose', { text: '   ' })).toBeNull();
    expect(deepLinkTarget('compose', { text: undefined })).toBeNull();
    expect(deepLinkTarget('compose', { text: '\n\t ' })).toBeNull();
    expect(deepLinkTarget('compose', { bot: 'scout' })).toBeNull();
  });

  test('a compose link carries the text as it arrived, and a repeat takes its first value', () => {
    // Shared content is untrusted input: the composer composes these very
    // characters onto the draft, so the fold must not re-word them — the rule
    // `spokenDraftText` states for a transcript. A repeated param is one
    // param, and its first value is the one the link meant.
    expect(deepLinkTarget('compose', { text: '  spaced  ' })).toEqual({
      kind: 'compose',
      text: '  spaced  ',
    });
    expect(deepLinkTarget('compose', { text: ['first', 'second'] })).toEqual({
      kind: 'compose',
      text: 'first',
    });
  });

  test("a compose link's Bot is trimmed like a chat link's, and an empty one names no Bot", () => {
    expect(deepLinkTarget('compose', { text: 'hi', bot: '  scout  ' })).toEqual({
      kind: 'compose',
      text: 'hi',
      botId: 'scout',
    });
    expect(deepLinkTarget('compose', { text: 'hi', bot: ['scout', 'night'] })).toEqual({
      kind: 'compose',
      text: 'hi',
      botId: 'scout',
    });
    // Absent, empty and whitespace-only all mean the same thing: the shared
    // text is for the surface already up, not a guessed thread.
    expect(deepLinkTarget('compose', { text: 'hi', bot: '   ' })).toEqual({
      kind: 'compose',
      text: 'hi',
    });
    expect(deepLinkTarget('compose', { text: 'hi', bot: undefined })).toEqual({
      kind: 'compose',
      text: 'hi',
    });
  });

  test('every other path is nothing at all', () => {
    expect(deepLinkTarget('settings', { bot: 'scout' })).toBeNull();
    // The vocabulary is case-sensitive and has no trailing-slash spelling:
    // an unrecognized path is a no-op, not a guess at the nearest one.
    expect(deepLinkTarget('CHAT', { bot: 'scout' })).toBeNull();
    expect(deepLinkTarget('chat/', { bot: 'scout' })).toBeNull();
    expect(deepLinkTarget('COMPOSE', { text: 'hi' })).toBeNull();
    expect(deepLinkTarget('compose/', { text: 'hi' })).toBeNull();
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
    // From the chat branch's own comment down: the add push and the compose
    // branch sit above it and are not what these cases are about.
    const chat = src.slice(src.indexOf('// A Bot Chat link opens the way a roster tap opens one'));

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
    // From the chat branch's own comment down: the add push and the compose
    // branch sit above it and are not what these cases are about.
    const chat = src.slice(src.indexOf('// A Bot Chat link opens the way a roster tap opens one'));

    // The same landing a failed roster tap takes: the operator reads the Bot
    // list rather than a header naming a thread that never opened.
    expect(chat).toContain("requestSurface({ kind: 'roster' })");
  });

  test('the Bot surface is asked for only on a landed open, the roster on a refusal', () => {
    const src = routerSource();
    // From the chat branch's own comment down: the add push and the compose
    // branch sit above it and are not what these cases are about.
    const chat = src.slice(src.indexOf('// A Bot Chat link opens the way a roster tap opens one'));

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
    // Everything after the add push is the compose and chat branches — neither
    // link branch checks the connection after it consumes, and each one's own
    // mark is behind its gate.
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

  test('a compose link lands on the Chat tab and hands its text to the screen', () => {
    const src = routerSource();
    const compose = src.slice(
      src.indexOf("if (target.kind === 'compose')"),
      src.indexOf('// A Bot Chat link opens the way a roster tap opens one'),
    );

    expect(compose.length).toBeGreaterThan(0);
    const navigate = compose.indexOf("router.navigate('/chat')");
    const ask = compose.indexOf('requestComposeRequest({ text: target.text })');
    expect(navigate).toBeGreaterThan(-1);
    // The tab is brought up first (a link may arrive on any tab), and the text
    // is handed to the screen as a REQUEST: the screen is what decides where a
    // text can be written, and it writes a draft rather than sending.
    expect(ask).toBeGreaterThan(navigate);
  });

  test('a compose link naming a Bot opens it first, and asks for the draft on that open', () => {
    const src = routerSource();
    const compose = src.slice(
      src.indexOf("if (target.kind === 'compose')"),
      src.indexOf('// A Bot Chat link opens the way a roster tap opens one'),
    );

    // The same open a chat link takes, in the same order: the text's own Bot
    // Chat has to be the thread on screen before a draft for it means anything.
    const open = compose.indexOf('openBot(botId)');
    const landed = compose.indexOf('.then((opened) => {');
    const surface = compose.indexOf("requestSurface({ kind: 'bot', botId })");
    const ask = compose.indexOf('requestComposeRequest({ text: target.text, botId })');
    expect(open).toBeGreaterThan(-1);
    expect(landed).toBeGreaterThan(open);
    expect(surface).toBeGreaterThan(landed);
    expect(ask).toBeGreaterThan(surface);
  });

  test('a refused open asks for neither the surface nor the draft', () => {
    const src = routerSource();
    const compose = src.slice(
      src.indexOf("if (target.kind === 'compose')"),
      src.indexOf('// A Bot Chat link opens the way a roster tap opens one'),
    );

    // The refusal branch is everything from its own `if (!opened) {` to the
    // `return;` that ends it.
    const refusalStart = compose.indexOf('if (!opened) {');
    const refusal = compose.slice(refusalStart, compose.indexOf('return;', refusalStart));

    expect(refusal).toContain("requestSurface({ kind: 'roster' })");
    // A refused open is a Bot Chat that never opened: nothing waits on it, so
    // the words are not held for a thread that is not there.
    expect(refusal).not.toContain('requestComposeRequest');
    expect(refusal).not.toContain("requestSurface({ kind: 'bot'");
  });

  test('every target the fold answers has a branch, and none of them sends', () => {
    const src = routerSource();

    // FUTURE-ITEMS.md:193-194 — shared content is untrusted input and lands as
    // a draft the operator reviews. No branch of this router sends it.
    expect(src).not.toContain('sendChatInput');

    // The fold answers exactly three targets and each has a branch of its own,
    // in that order: no target can fall through unhandled and ride the union's
    // Bot id into `openBot` — the guard that stood in for the compose branch
    // while it was a later slice has nothing left to hold back.
    const add = src.indexOf("if (target.kind === 'add')");
    const compose = src.indexOf("if (target.kind === 'compose')");
    const chat = src.indexOf('// A Bot Chat link opens the way a roster tap opens one');
    expect(add).toBeGreaterThan(-1);
    expect(compose).toBeGreaterThan(add);
    expect(chat).toBeGreaterThan(compose);
    expect(src).not.toContain("if (target.kind !== 'chat') return;");
  });
});
