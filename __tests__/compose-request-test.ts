import { composeRequestApplies, pendingComposeRequest } from '@/lib/gateway/compose-request';

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
const requestModule = () => readSource('src', 'lib', 'gateway', 'compose-request.ts');

/** The shared gateway value every consumer of the context reads. */
const contextValue = () =>
  between(provider(), 'const value = useMemo<GatewayContextValue>(', 'const chatSurfaceValue');

describe('pendingComposeRequest (the fold the provider holds the request in)', () => {
  test('a request with nothing pending is the pending request', () => {
    expect(pendingComposeRequest(null, { text: 'look at this', botId: 'scout' })).toEqual({
      text: 'look at this',
      botId: 'scout',
    });
  });

  test('the same words for the same thread keep the value, so nothing re-fires', () => {
    const pending = { text: 'look at this', botId: 'scout' };

    expect(pendingComposeRequest(pending, { text: 'look at this', botId: 'scout' })).toBe(pending);
  });

  test('a request naming no Bot is the same request when the text is', () => {
    const pending = { text: 'look at this' };

    expect(pendingComposeRequest(pending, { text: 'look at this' })).toBe(pending);
  });

  test('a second share of other words replaces one never consumed', () => {
    // Two links in a row carry two texts; the one the operator shared last is
    // the one waiting for the composer.
    expect(pendingComposeRequest({ text: 'first' }, { text: 'second' })).toEqual({ text: 'second' });
  });

  test('the same words for another thread is a new request', () => {
    const pending = { text: 'look at this', botId: 'scout' };

    const next = pendingComposeRequest(pending, { text: 'look at this', botId: 'coder' });
    expect(next).toEqual({ text: 'look at this', botId: 'coder' });
    expect(next).not.toBe(pending);
  });

  test('a cleared request is gone: the same text next time is a fresh request', () => {
    // The screen clears as it applies, so the pending slot is null again — and
    // a share of the same words again is a new ask, not the old one returned.
    expect(pendingComposeRequest(null, { text: 'look at this' })).not.toBe(null);
  });
});

describe('composeRequestApplies (which thread may take the shared text)', () => {
  test('only the Bot Chat a request names', () => {
    expect(composeRequestApplies({ text: 'look', botId: 'scout' }, { kind: 'bot', botId: 'scout' })).toBe(true);
  });

  test('another thread is not the thread the request named', () => {
    expect(composeRequestApplies({ text: 'look', botId: 'scout' }, { kind: 'bot', botId: 'coder' })).toBe(false);
    expect(composeRequestApplies({ text: 'look', botId: 'scout' }, { kind: 'configurable' })).toBe(false);
    expect(composeRequestApplies({ text: 'look', botId: 'scout' }, { kind: 'group', groupId: 'scout' })).toBe(false);
    expect(composeRequestApplies({ text: 'look', botId: 'scout' }, { kind: 'roster' })).toBe(false);
  });

  test('a request naming no Bot lands on the thread already up', () => {
    // A shared text arrives with no opinion about where it goes: it does not
    // pull the operator to another thread, it waits for the composer that is.
    expect(composeRequestApplies({ text: 'look' }, { kind: 'bot', botId: 'scout' })).toBe(true);
    expect(composeRequestApplies({ text: 'look' }, { kind: 'configurable' })).toBe(true);
  });

  test('a request naming no Bot is not for a surface with no composer of this screen', () => {
    // The roster has no composer and a group room keeps its own draft to
    // itself, so a shared text handed to either could not be written — the
    // screen holds the request instead of consuming it.
    expect(composeRequestApplies({ text: 'look' }, { kind: 'roster' })).toBe(false);
    expect(composeRequestApplies({ text: 'look' }, { kind: 'group', groupId: 'scout' })).toBe(false);
  });

  test('nothing pending applies to nothing', () => {
    expect(composeRequestApplies(null, { kind: 'bot', botId: 'scout' })).toBe(false);
    expect(composeRequestApplies(null, { kind: 'configurable' })).toBe(false);
  });
});

describe('the pending compose request is provider-owned', () => {
  test('the request is held on the gateway context and cleared by its consumer', () => {
    const src = provider();

    // Held in the provider, not in the screen: the link is answered in the
    // router, where the composer's own draft does not exist, so the request
    // must outlive the render that asked for it.
    expect(src).toContain(
      'const [requestedComposeRequest, setRequestedComposeRequest] = useState<ComposeRequest | null>(null);',
    );
    expect(src).toContain('setRequestedComposeRequest((prev) => pendingComposeRequest(prev, request));');
    expect(src).toContain('requestedComposeRequest: ComposeRequest | null;');
    expect(src).toContain('requestComposeRequest: (request: ComposeRequest) => void;');
    expect(src).toContain('clearRequestedComposeRequest: () => void;');
  });

  test('the value memo hands the request, its setter and its clear to every consumer', () => {
    const value = contextValue();

    expect(value).toContain('requestedComposeRequest,');
    expect(value).toContain('requestComposeRequest,');
    expect(value).toContain('clearRequestedComposeRequest,');
  });

  test('the composer focus and the requested surface keep their own slots', () => {
    // Must still: this request rides BESIDE the focus and the surface the Bot
    // Chat link already holds; neither is rebuilt on top of it.
    const src = provider();

    expect(src).toContain(
      'const [requestedComposerFocus, setRequestedComposerFocus] = useState<ComposerFocus | null>(null);',
    );
    expect(src).toContain('clearRequestedComposerFocus: () => void;');
    expect(src).toContain('const [requestedSurface, setRequestedSurface] = useState<ChatSurface | null>(null);');
    expect(src).toContain('clearRequestedSurface: () => void;');
    expect(contextValue()).toContain('requestedComposerFocus,');
    expect(contextValue()).toContain('requestedSurface,');
  });
});

describe('the Chat screen writes a shared text into the thread\'s own draft', () => {
  const chatScreen = () => readSource('src', 'components', 'chat', 'chat-screen.tsx');

  /** The screen's consumer — the effect that turns a request into a draft. */
  const consumer = () =>
    between(
      chatScreen(),
      'if (!requestedComposeRequest || !isFocused || !draftThread) return undefined;',
      '// Stable header callbacks',
    );

  test('the request is read off the gateway context, and only applied where it applies', () => {
    const src = chatScreen();

    expect(src).toContain('requestedComposeRequest,');
    expect(src).toContain('clearRequestedComposeRequest,');
    expect(src).toContain('composeRequestApplies(requestedComposeRequest, surface)');
  });

  test('the shared text is composed onto the thread\'s draft through the one writer', () => {
    const block = consumer();

    expect(block.length).toBeGreaterThan(0);
    // The module's own composition rule: words already typed are never dropped
    // and the shared text is never re-worded. One writer, not a second one.
    expect(block).toContain('setDraft(spokenDraftText(draft, requestedComposeRequest.text))');
    expect((block.match(/setDraft\(/g) ?? []).length).toBe(1);
    expect(block).toContain('composerInputRef.current?.focus()');
  });

  test('the request is held rather than dropped where the screen cannot write it yet', () => {
    const block = consumer();

    // The guard and the applies-check come before the write: a request for
    // another thread — or one landed before a thread is up — stays pending for
    // the thread it names, because the promise was that thread's draft.
    const applies = block.indexOf('composeRequestApplies(requestedComposeRequest, surface)');
    expect(applies).toBeGreaterThan(-1);
    expect(applies).toBeLessThan(block.indexOf('setTimeout('));
    expect(chatScreen()).toContain('if (!requestedComposeRequest || !isFocused || !draftThread) return undefined;');
  });

  test('the shared text waits for the thread\'s stored draft to have been read', () => {
    const block = consumer();
    const held = 'if (drafts[composerDraftKey(draftThread)] === undefined) return undefined;';

    // The load above keeps whatever a thread already holds, so a shared text
    // written before that thread's stored draft has been read is the value that
    // stays — and the words the operator had left in it never arrive.
    expect(chatScreen()).toContain(held);
    expect(block.indexOf(held)).toBeLessThan(block.indexOf('setTimeout('));
  });

  test('it is cleared as it applies, so it cannot fight the operator\'s own next edit', () => {
    const block = consumer();

    expect(block).toContain('clearRequestedComposeRequest();');
    expect(block.indexOf('setDraft(')).toBeLessThan(block.indexOf('clearRequestedComposeRequest();'));
  });

  test('nothing on the shared-text path sends', () => {
    const block = consumer();

    expect(block).not.toContain('sendChatInput');
    expect(block).not.toContain('send(');
  });
});

describe('a shared text can only ever be a draft', () => {
  test('the request shapes as a text and a Bot id, and nothing else', () => {
    expect(requestModule()).toContain('export type ComposeRequest = { text: string; botId?: string };');
  });

  test('the module that carries it has no send in it', () => {
    // FUTURE-ITEMS.md:193-194 — shared content is untrusted input; it goes into
    // the composer as a draft, never auto-sent. The fold knows no send path.
    expect(requestModule()).not.toContain('sendChatInput');
    expect(requestModule()).not.toContain('onSend');
  });
});
