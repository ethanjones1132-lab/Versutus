declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readTerminalOutputSource(): string {
  // terminal-output.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'terminal', 'terminal-output.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('terminal output scroll pin', () => {
  test('auto-follow is guarded by a pinned ref instead of jumping unconditionally', () => {
    // While a command streams, every new line changes content size; the pane
    // must only chase the tail while the operator is still near it.
    const src = readTerminalOutputSource();
    const handler = src.match(/const handleContentSizeChange = useCallback\([\s\S]*?\]\);/)?.[0];
    expect(handler).toBeDefined();
    expect(handler).toMatch(/pinnedRef\.current/);
    expect(handler).toMatch(/scrollToEnd/);
    const list = src.match(/<FlatList\s+ref=\{listRef\}[\s\S]*?\/>/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/onContentSizeChange=\{handleContentSizeChange\}/);
    expect(list).not.toMatch(/onContentSizeChange=\{\(\) =>/);
  });

  test('the scroll handler computes distance from the bottom and pins inside the threshold', () => {
    const src = readTerminalOutputSource();
    const handler = src.match(/const handleScroll = useCallback\([\s\S]*?\],\n\s*\);/)?.[0];
    expect(handler).toBeDefined();
    expect(handler).toMatch(
      /contentSize\.height - contentOffset\.y - layoutMeasurement\.height/,
    );
    expect(handler).toMatch(/pinnedRef\.current = distanceFromBottom < PIN_THRESHOLD_PX/);
  });

  test('the FlatList wires the guarded handlers and still forwards onScroll to the parent', () => {
    const src = readTerminalOutputSource();
    const list = src.match(/<FlatList\s+ref=\{listRef\}[\s\S]*?\/>/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/onScroll=\{handleScroll\}/);
    expect(list).toMatch(/onContentSizeChange=\{handleContentSizeChange\}/);
    const handler = src.match(/const handleScroll = useCallback\([\s\S]*?\],\n\s*\);/)?.[0];
    expect(handler).toMatch(/onScroll\?\.\(event\)/);
  });
});