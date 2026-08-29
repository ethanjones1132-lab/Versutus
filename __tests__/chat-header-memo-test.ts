declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatHeaderSource(): string {
  // chat-header.tsx is CRLF on disk; normalize so the assertions below do not
  // depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-header.tsx'].join(SEP),
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

describe('chat header render cost', () => {
  test('ChatHeader is exported via React.memo so an unchanged frame skips the header subtree', () => {
    // The Chat tab mounts ChatHeader directly inside the surface component that
    // re-renders on every coalesced streamed frame. Wrapping the export in memo
    // lets a frame that changed only `messages` (or any other surface state) skip
    // re-running the header body — orb, titles, and the model/session chips — the
    // same way the thread rows (iter-071) and roster (iter-090) were memoized.
    const src = readChatHeaderSource();
    expect(src).toMatch(/export const ChatHeader = memo\(ChatHeaderImpl\)/);
    expect(src).toMatch(/ChatHeader\.displayName = 'ChatHeader'/);
  });

  test('the chat-screen call site passes stable header callbacks, not inline arrow wrappers', () => {
    // Inline arrows (e.g. `() => void openSessionSelector()`) get a fresh identity
    // every render, which defeats React.memo and re-renders the header on every
    // frame regardless. The call site must hand memo stable, single-reference
    // callbacks (the handleHeader*Press useCallback wrappers) so a message-only
    // change short-circuits the header.
    const src = readChatScreenSource();
    const header = src.match(/<ChatHeader[\s\S]*?\/>/)?.[0];
    expect(header).toBeDefined();

    // Each press prop is the stable wrapper, never an inline arrow that would
    // allocate a new function per render.
    expect(header).toMatch(/onSessionPress=\{threadSurface \? handleHeaderSessionPress : undefined\}/);
    expect(header).toMatch(/onModelPress=\{threadSurface \? handleHeaderModelPress : undefined\}/);
    expect(header).toMatch(/onOverflowPress=\{threadSurface \? handleHeaderOverflowPress : undefined\}/);
    expect(header).toMatch(
      /onBackendPress=\{surface\.kind === 'configurable' && backends\.length > 0 \? handleHeaderBackendPress : undefined\}/,
    );
    expect(header).toMatch(
      /onRosterPress=\{surface\.kind === 'roster' \? undefined : handleHeaderRosterPress\}/,
    );

    // No leftover inline arrow wrappers at the header call site — those are what
    // defeated memo before this change.
    expect(header).not.toMatch(/onSessionPress=\{threadSurface \? \(\) =>/);
    expect(header).not.toMatch(/onModelPress=\{threadSurface \? \(\) =>/);
    expect(header).not.toMatch(/onOverflowPress=\{threadSurface \? \(\) =>/);
    expect(header).not.toMatch(/onBackendPress=\{[^}]*\? \(\) =>/);
    expect(header).not.toMatch(/onRosterPress=\{[^}]*=> \{\s*clearBot\(\)/);
  });

  test('the stable header callbacks are defined once as useCallback wrappers', () => {
    // These are the single references the memoized header receives. Each is a
    // useCallback whose deps are stable (a provider callback or a useState setter),
    // so its identity holds across every streamed frame.
    const src = readChatScreenSource();
    expect(src).toMatch(/const handleHeaderSessionPress = useCallback\(\(\) => \{\s*void openSessionSelector\(\);\s*\}, \[openSessionSelector\]\);/);
    expect(src).toMatch(/const handleHeaderModelPress = useCallback\(\(\) => \{\s*void openModelPicker\('default'\);\s*\}, \[openModelPicker\]\);/);
    expect(src).toMatch(/const handleHeaderOverflowPress = useCallback\(\(\) => \{\s*setOverflowVisible\(true\);\s*\}, \[\]\);/);
    expect(src).toMatch(/const handleHeaderBackendPress = useCallback\(\(\) => \{\s*setBackendPickerVisible\(true\);\s*\}, \[\]\);/);
    expect(src).toMatch(
      /const handleHeaderRosterPress = useCallback\(\(\) => \{\s*clearBot\(\);\s*showSurface\(\{ kind: 'roster' \}\);\s*\}, \[clearBot, showSurface\]\);/,
    );
  });
});
