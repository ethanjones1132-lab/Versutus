declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', 'src', relative].join(SEP), 'utf8');
}

describe('chat-screen session and model derivations', () => {
  test('the sessions map is memoized on sessionList, not rebuilt every render', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The old bare map — `(sessionList as SessionRecord[]).map(toSessionItem)` —
    // at the `sessions =` binding must be gone; it is now wrapped in useMemo.
    expect(screen).not.toMatch(
      /const sessions = \(sessionList as SessionRecord\[\]\)\.map\(toSessionItem\);/,
    );
    // It still maps the same way, just inside a useMemo keyed by `sessionList`.
    expect(screen).toMatch(/const sessions = useMemo\(/);
    expect(screen).toMatch(/\(sessionList as SessionRecord\[\]\)\.map\(toSessionItem\)/);
    expect(screen).toMatch(/\[sessionList\]/);
  });

  test('the model catalog map is memoized on modelCatalog, not rebuilt inline', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The inline `models={modelCatalog.map(...)}` prop must be gone; the rows
    // are now computed once into a stable `modelRows` and passed by identity.
    expect(screen).not.toMatch(/models=\{\s*modelCatalog\.map\(/);
    // The catalog is still mapped, but inside a useMemo keyed by `modelCatalog`.
    expect(screen).toMatch(/const modelRows = useMemo\(/);
    expect(screen).toMatch(/modelCatalog\.map\(/);
    expect(screen).toMatch(/\[modelCatalog\]/);
    // The prop reads the memoized array by name.
    expect(screen).toMatch(/models=\{\s*modelRows\s*\}/);
  });
});
