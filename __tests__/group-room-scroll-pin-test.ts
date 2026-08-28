declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGroupRoomViewSource(): string {
  // group-room-view.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('group room scroll pin', () => {
  test('scrollToBottom is guarded by the pinned ref instead of jumping unconditionally', () => {
    // A round can resolve minutes after the operator scrolls up to re-read
    // earlier replies; the tail must only be chased while they are near it.
    const src = readGroupRoomViewSource();
    const scrollToBottom = src.match(/const scrollToBottom = \(\) => \{[\s\S]*?\};/)?.[0];
    expect(scrollToBottom).toBeDefined();
    expect(scrollToBottom).toMatch(/if \(!pinnedRef\.current\) return;/);
    expect(scrollToBottom).toMatch(/scrollToEnd/);
    // The initial state is pinned, so a fresh room still follows the tail.
    expect(src).toMatch(/pinnedRef = useRef\(true\)/);
  });

  test('the scroll handler computes distance from the bottom and pins inside the threshold', () => {
    const src = readGroupRoomViewSource();
    const handler = src.match(/const handleScroll = useCallback\([\s\S]*?\]\);/)?.[0];
    expect(handler).toBeDefined();
    expect(handler).toMatch(
      /contentSize\.height - contentOffset\.y - layoutMeasurement\.height/,
    );
    expect(handler).toMatch(/pinnedRef\.current = distanceFromBottom < PIN_THRESHOLD_PX/);
  });

  test('the room ScrollView wires the guarded scroll handler', () => {
    const src = readGroupRoomViewSource();
    const scrollView = src.match(/<ScrollView\s+ref=\{scrollRef\}[\s\S]*?>/)?.[0];
    expect(scrollView).toBeDefined();
    expect(scrollView).toMatch(/onScroll=\{handleScroll\}/);
    expect(scrollView).toMatch(/scrollEventThrottle=\{16\}/);
    expect(scrollView).not.toMatch(/onScroll=\{\(\}\) =>/);
  });
});