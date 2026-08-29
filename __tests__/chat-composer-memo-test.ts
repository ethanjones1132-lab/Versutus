declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatComposerSource(): string {
  // chat-composer.tsx is CRLF on disk; normalize so the assertions below do not
  // depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-composer.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readChatScreenSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('chat composer render cost', () => {
  test('ChatComposer is exported via React.memo so an unchanged frame skips the composer subtree', () => {
    // The Chat tab mounts ChatComposer directly inside the surface component that
    // re-renders on every coalesced streamed frame. Wrapping the export in memo
    // lets a frame that changed only `messages` skip re-running the composer body
    // — the multiline TextField, quick actions and inline palette — the same way
    // the thread rows (iter-071), roster (iter-090) and header (iter) were
    // memoized. An uncontrolled field re-rendering each frame is a known jank
    // source while the operator types.
    const src = readChatComposerSource();
    expect(src).toMatch(/export const ChatComposer = memo\(function ChatComposer\(/);
  });

  test('the chat-screen call site passes handleSend/stopStreaming by reference, not inline arrow wrappers', () => {
    // Inline arrows (e.g. `() => void handleSend()`) get a fresh identity every
    // render, which defeats React.memo and re-renders the composer on every frame
    // regardless. handleSend (chat-screen.tsx:531) and stopStreaming (provider
    // line 2240) are both useCallback with stable deps, so passing them by
    // reference holds identity across streamed frames.
    const src = readChatScreenSource();
    const composer = src.match(/<ChatComposer[\s\S]*?\/>/)?.[0];
    expect(composer).toBeDefined();

    expect(composer).toMatch(/onSend=\{handleSend\}/);
    expect(composer).toMatch(/onStop=\{stopStreaming\}/);

    // No leftover inline arrow wrappers at the composer call site — those are
    // what defeated memo before this change.
    expect(composer).not.toMatch(/onSend=\{\(\) =>/);
    expect(composer).not.toMatch(/onStop=\{\(\) =>/);
  });

  test('the chat-screen call site hands the memoized composer a stable quickActions array', () => {
    // An inline `quickActions={[...]}` array literal allocates a new identity on
    // every render and would defeat memo. The array must be built once via
    // useMemo so a message-only change short-circuits the composer.
    const src = readChatScreenSource();
    const composer = src.match(/<ChatComposer[\s\S]*?\/>/)?.[0];
    expect(composer).toBeDefined();

    expect(composer).toMatch(/quickActions=\{quickActions\}/);
    // The inline literal is gone from the call site.
    expect(composer).not.toMatch(/quickActions=\{\[/);

    // The memoized array exists once in the surface body (stable identity so a
    // message-only change short-circuits the memoized composer).
    expect(src).toMatch(
      /const quickActions: \{ label: string; draft: string; icon: IconName \}\[\] = useMemo\(/,
    );
    expect(src).toMatch(/\{ label: 'Run', draft: '\/run '/);
    expect(src).toMatch(/\{ label: 'Status', draft: '\/status'/);
    expect(src).toMatch(/\{ label: 'Help', draft: '\/help'/);
  });

  test('the chat-screen call site hands the memoized composer stable slash/browse callbacks', () => {
    // onSelectSlashSuggestion and onBrowseCommands used to be inline arrows too.
    // setDraft (useState setter) is stable, and openPalette is a useCallback
    // wrapping setPaletteVisible, so both hold identity across frames.
    const src = readChatScreenSource();
    const composer = src.match(/<ChatComposer[\s\S]*?\/>/)?.[0];
    expect(composer).toBeDefined();

    expect(composer).toMatch(/onSelectSlashSuggestion=\{setDraft\}/);
    expect(composer).toMatch(/onBrowseCommands=\{openPalette\}/);

    expect(composer).not.toMatch(/onSelectSlashSuggestion=\{\(value\) =>/);
    expect(composer).not.toMatch(/onBrowseCommands=\{\(\) =>/);
  });
});
