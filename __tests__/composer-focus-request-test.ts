import { composerFocusApplies, pendingComposerFocus } from '@/lib/gateway/composer-focus';

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
const composer = () => readSource('src', 'components', 'chat', 'chat-composer.tsx');
const field = () => readSource('src', 'components', 'ui', 'TextField.tsx');
const fieldIos = () => readSource('src', 'components', 'ui', 'TextField.ios.tsx');

/** The link vocabulary's router — the producer of a focus request. */
const routerSource = () =>
  between(layout(), 'function GatewayDeepLinkRouter', 'export default function RootLayout');

/** The shared gateway value every consumer of the context reads. */
const contextValue = () =>
  between(provider(), 'const value = useMemo<GatewayContextValue>(', 'const chatSurfaceValue');

describe('pendingComposerFocus (the fold the provider holds the request in)', () => {
  test('a request with nothing pending is the pending request', () => {
    expect(pendingComposerFocus(null, { botId: 'scout' })).toEqual({ botId: 'scout' });
  });

  test('re-requesting the Bot Chat already pending keeps the value, so nothing re-fires', () => {
    const pending = { botId: 'scout' };

    expect(pendingComposerFocus(pending, { botId: 'scout' })).toBe(pending);
  });

  test('a later request for another Bot Chat replaces one never consumed', () => {
    // Two links in a row open two threads; the one the operator last asked for
    // is the one whose composer takes the cursor.
    expect(pendingComposerFocus({ botId: 'scout' }, { botId: 'coder' })).toEqual({ botId: 'coder' });
  });

  test('a cleared request is gone: the same Bot next time is a fresh request', () => {
    // The screen clears as it applies, so the pending slot is null again — and
    // a second link for the same Bot is a new ask, not the old one returned.
    expect(pendingComposerFocus(null, { botId: 'scout' })).not.toBe(null);
  });
});

describe('composerFocusApplies (which screen may open the keyboard)', () => {
  test('only the Bot Chat a request names', () => {
    expect(composerFocusApplies({ botId: 'scout' }, { kind: 'bot', botId: 'scout' })).toBe(true);
  });

  test('another thread is not the thread the request named', () => {
    expect(composerFocusApplies({ botId: 'scout' }, { kind: 'bot', botId: 'coder' })).toBe(false);
    expect(composerFocusApplies({ botId: 'scout' }, { kind: 'group', groupId: 'scout' })).toBe(false);
    expect(composerFocusApplies({ botId: 'scout' }, { kind: 'configurable' })).toBe(false);
    expect(composerFocusApplies({ botId: 'scout' }, { kind: 'roster' })).toBe(false);
  });

  test('nothing pending applies to nothing', () => {
    expect(composerFocusApplies(null, { kind: 'bot', botId: 'scout' })).toBe(false);
  });
});

describe('the pending focus is provider-owned', () => {
  test('the request is held on the gateway context and cleared by its consumer', () => {
    const src = provider();

    // Held in the provider, not in the screen: the open is a gateway read, and
    // the request must outlive the render that asked for it.
    expect(src).toContain(
      'const [requestedComposerFocus, setRequestedComposerFocus] = useState<ComposerFocus | null>(null);',
    );
    expect(src).toContain('setRequestedComposerFocus((prev) => pendingComposerFocus(prev, focus));');
    expect(src).toContain('requestedComposerFocus: ComposerFocus | null;');
    expect(src).toContain('requestComposerFocus: (focus: ComposerFocus) => void;');
    expect(src).toContain('clearRequestedComposerFocus: () => void;');
  });

  test('the value memo hands the request, its setter and its clear to every consumer', () => {
    const value = contextValue();

    expect(value).toContain('requestedComposerFocus,');
    expect(value).toContain('requestComposerFocus,');
    expect(value).toContain('clearRequestedComposerFocus,');
  });
});

describe('the Bot Chat link asks for the focus once the open has landed', () => {
  test('the router asks for the Bot the open resolved, after that open landed', () => {
    const src = routerSource();

    const open = src.indexOf('openBot(target.botId)');
    const ask = src.indexOf("requestSurface({ kind: 'bot', botId: target.botId })");
    const focus = src.indexOf('requestComposerFocus({ botId: target.botId })');

    expect(open).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(open);
    expect(focus).toBeGreaterThan(ask);
  });

  test('the ask is a single call site, inside the landed-open branch', () => {
    const src = routerSource();
    const focus = src.indexOf('requestComposerFocus(');

    expect(src).toContain('requestComposerFocus,');
    // One ask, in the branch the open resolves into — the refused-open path
    // (the roster fallback) asks for no cursor anywhere.
    expect(src.indexOf('requestComposerFocus(', focus + 1)).toBe(-1);
    // The CHAT branch's landed-open block: the compose branch above it has an
    // open of its own, and what it asks for there is a draft, not a cursor.
    const chat = src.slice(src.indexOf('// A Bot Chat link opens the way a roster tap opens one'));
    expect(between(chat, '.then((opened) => {', '.catch(')).toContain(
      'requestComposerFocus({ botId: target.botId })',
    );
  });

  test('a link never sends, and the screen decides whether it can be honoured', () => {
    const src = routerSource();

    // The destination decision is the fold's, and a focus request carries no
    // text: the composer it opens is empty until the operator types.
    expect(src).not.toContain('sendChatInput');
    expect(src).toContain('deepLinkTarget(parsed.path, parsed.queryParams ?? {})');
  });
});

describe('the chat screen applies the focus and clears it', () => {
  test('the screen reads the request off the gateway context', () => {
    const src = screen();

    expect(src).toContain('requestedComposerFocus,');
    expect(src).toContain('clearRequestedComposerFocus,');
  });

  test('the screen owns the field handle it focuses', () => {
    const src = screen();

    expect(src).toContain('const composerInputRef = useRef<TextFieldHandle>(null);');
    expect(src).toContain('inputRef={composerInputRef}');
  });

  test('it applies only on the focused Chat screen showing the Bot Chat it names', () => {
    const src = screen();
    const effect = between(src, 'if (!requestedComposerFocus', '}, [requestedComposerFocus');

    // A request that lands while the operator is on another tab, or over a
    // thread they moved to, must not open the keyboard over a screen they left.
    expect(src).toContain('useIsFocused');
    expect(effect).toContain('!isFocused');
    expect(effect).toContain('composerFocusApplies(requestedComposerFocus, surface)');
  });

  test('it focuses, then clears — on a tick, and exactly once', () => {
    const src = screen();
    const effect = between(src, 'if (!requestedComposerFocus', '}, [requestedComposerFocus');
    const focus = effect.indexOf('composerInputRef.current?.focus()');
    const clear = effect.indexOf('clearRequestedComposerFocus()');

    expect(focus).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(focus);
    // Deferred like every other producer in this repo, and the request is
    // retired with the focus it delivered — one ask, one cursor.
    expect(effect).toContain('setTimeout(() => {');
    expect(src.indexOf('clearRequestedComposerFocus()', src.indexOf('clearRequestedComposerFocus()') + 1)).toBe(-1);
  });

  test('a consumed request does not re-apply on later renders', () => {
    expect(screen()).toContain(
      '}, [requestedComposerFocus, isFocused, surface, clearRequestedComposerFocus]);',
    );
  });
});

describe('the composer hands its field the input handle', () => {
  test('the composer takes the handle and passes it to its only field', () => {
    const src = composer();

    expect(src).toContain('inputRef?: Ref<TextFieldHandle>;');
    expect(src).toContain('inputRef,');
    expect(src).toContain('inputRef={inputRef}');
  });

  test('the handle is named by the kit, so no surface imports the raw input', () => {
    // The raw-TextInput retirement guard allows react-native's `TextInput` only
    // inside the two kit field files; a host that has to hold an input asks the
    // kit for the handle's name instead (__tests__/raw-text-input-retirement-test.ts).
    expect(field()).toContain('export type TextFieldHandle = TextInput;');
    expect(fieldIos()).toContain('export type TextFieldHandle = TextFieldRef;');
    expect(readSource('src', 'components', 'ui', 'index.ts')).toContain(
      "export type { TextFieldHandle } from './TextField';",
    );
  });

  test('the field forwards it on both platform fields', () => {
    // The base field is a react-native TextInput, so its handle is the input's
    // own instance; the iOS field is the SwiftUI field, whose handle exposes
    // focus() too — the one method this feature asks for exists on each.
    expect(field()).toContain('inputRef?: Ref<TextFieldHandle>;');
    expect(field()).toContain('ref={inputRef}');
    expect(fieldIos()).toContain('inputRef?: Ref<TextFieldHandle>;');
    expect(fieldIos()).toContain('ref={inputRef}');
  });

  test('a field with no handle is unchanged', () => {
    // Optional on every field: the composer is the only caller that passes one,
    // and every other TextField in the app keeps rendering as it did.
    expect(field()).toContain('inputRef,');
    expect(fieldIos()).toContain('inputRef,');
  });
});
