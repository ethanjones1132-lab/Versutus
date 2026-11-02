import {
  INITIAL_AUTO_SCROLL,
  nextAutoScroll,
  type AutoScrollEvent,
  type AutoScrollState,
} from '@/lib/chat/auto-scroll';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', 'src', relative].join(SEP), 'utf8');
}

function contentSize(
  contentHeight: number,
  { pinned = true, animated = true }: { pinned?: boolean; animated?: boolean } = {},
): AutoScrollEvent {
  return { type: 'content-size', contentHeight, pinned, animated };
}

function frame(): AutoScrollEvent {
  return { type: 'frame' };
}

/** Apply a run of events, collecting every scroll request the reducer made. */
function run(events: AutoScrollEvent[], from: AutoScrollState = INITIAL_AUTO_SCROLL): {
  state: AutoScrollState;
  scrolls: { animated: boolean }[];
} {
  let state = from;
  const scrolls: { animated: boolean }[] = [];
  for (const event of events) {
    const step = nextAutoScroll(state, event);
    state = step.state;
    if (step.scroll) scrolls.push(step.scroll);
  }
  return { state, scrolls };
}

describe('the transcript auto-scroll coalescer', () => {
  test('the first content-size event while pinned follows the content', () => {
    const step = nextAutoScroll(INITIAL_AUTO_SCROLL, contentSize(480));
    expect(step.scroll).toEqual({ animated: true });
    expect(step.state.framePending).toBe(true);
  });

  test('a streaming growth jumps and a settled one glides, exactly as before', () => {
    const streaming = run([contentSize(480, { animated: false })]);
    expect(streaming.scrolls).toEqual([{ animated: false }]);
    const settled = run([contentSize(480, { animated: true })]);
    expect(settled.scrolls).toEqual([{ animated: true }]);
  });

  test('several growths inside one frame ask for one scroll, not one each', () => {
    // Three delta batches land before the frame boundary: the old handler
    // restarted scrollToEnd on every one of them.
    const { scrolls, state } = run([contentSize(400), contentSize(460), contentSize(520)]);
    expect(scrolls).toEqual([{ animated: true }]);
    expect(state.framePending).toBe(true);
    expect(state.owed).toEqual({ animated: true });
  });

  test('the frame boundary spends the growth that arrived after the request', () => {
    const { scrolls } = run([contentSize(400), contentSize(460), contentSize(520), frame()]);
    expect(scrolls).toEqual([{ animated: true }, { animated: true }]);
  });

  test('the owed scroll keeps the streaming flag it was requested with', () => {
    const { scrolls } = run([
      contentSize(400, { animated: false }),
      contentSize(460, { animated: false }),
      frame(),
    ]);
    expect(scrolls).toEqual([{ animated: false }, { animated: false }]);
  });

  test('the frame after the owed scroll closes without asking again', () => {
    const { scrolls, state } = run([
      contentSize(400),
      contentSize(460),
      frame(),
      frame(),
    ]);
    expect(scrolls).toHaveLength(2);
    expect(state.framePending).toBe(false);
    expect(state.owed).toBeNull();
  });

  test('growth in a later frame is followed again', () => {
    const { scrolls } = run([
      contentSize(400),
      frame(), // closes the first frame, no owed growth
      contentSize(460), // a new frame's first growth
    ]);
    expect(scrolls).toEqual([{ animated: true }, { animated: true }]);
  });

  test('a height that did not grow asks for nothing', () => {
    const { scrolls } = run([contentSize(480), frame(), contentSize(480), contentSize(400)]);
    expect(scrolls).toEqual([{ animated: true }]);
  });

  test('while unpinned nothing moves; pinning lets the next growth follow', () => {
    const { scrolls, state } = run([
      contentSize(480, { pinned: false }),
      contentSize(560, { pinned: false }),
      frame(),
      contentSize(640, { pinned: true }),
    ]);
    expect(scrolls).toEqual([{ animated: true }]);
    expect(state.framePending).toBe(true);
  });

  test('a frame with nothing pending is inert', () => {
    const step = nextAutoScroll(INITIAL_AUTO_SCROLL, frame());
    expect(step.scroll).toBeUndefined();
    expect(step.state).toBe(INITIAL_AUTO_SCROLL);
  });

  test('a call without a reported height keeps the legacy follow', () => {
    // The list always reports both dimensions; a caller that hands over no
    // geometry cannot prove growth, so it follows once per call as it did
    // before coalescing rather than being silently dropped — pinning still
    // gates it, exactly as the old handler's `if (pinnedRef.current)` did.
    const noGeometry = nextAutoScroll(INITIAL_AUTO_SCROLL, {
      type: 'content-size',
      contentHeight: Number.NaN,
      pinned: true,
      animated: false,
    });
    expect(noGeometry.scroll).toEqual({ animated: false });
    const repeated = nextAutoScroll(noGeometry.state, {
      type: 'content-size',
      contentHeight: Number.NaN,
      pinned: true,
      animated: false,
    });
    expect(repeated.scroll).toEqual({ animated: false });
    const unpinned = nextAutoScroll(INITIAL_AUTO_SCROLL, {
      type: 'content-size',
      contentHeight: Number.NaN,
      pinned: false,
      animated: false,
    });
    expect(unpinned.scroll).toBeUndefined();
  });
});

describe('chat-screen routes transcript growth through the coalescer', () => {
  const screen = readSource('components/chat/chat-screen.tsx');
  const handler = screen.match(
    /const handleContentSizeChange = useCallback\([\s\S]*?\n\s*\},?\n\s*\[isStreaming\],\n\s*\);/,
  )?.[0];

  test('the content-size handler runs the pure reducer', () => {
    expect(handler).toBeDefined();
    expect(handler).toMatch(/nextAutoScroll\(/);
    expect(handler).toMatch(/INITIAL_AUTO_SCROLL|autoScrollRef/);
  });

  test('the pin still comes from the list scroll and the existing gestures', () => {
    expect(handler).toMatch(/pinned: pinnedRef\.current/);
    expect(screen).toMatch(/pinnedRef\.current = distanceFromBottom < PIN_THRESHOLD_PX;/);
    // A pill tap and a send still pin and glide; they are gestures, not the
    // streaming content-size path, and keep today's animated scroll.
    expect(screen).toMatch(/pinnedRef\.current = true;\n\s*listRef\.current\?\.scrollToEnd\(\{ animated: true \}\);/);
  });

  test('the handler no longer restarts one scroll per content-size event', () => {
    expect(handler).not.toMatch(/scrollToEnd\(\{ animated: !isStreaming \}\)/);
    // One frame may carry at most one request; the boundary is the only place
    // the owed growth is spent.
    expect(handler).toMatch(/requestAnimationFrame\(function autoScrollFrame\(\)/);
    expect(handler).toMatch(/type: 'frame'/);
  });

  test('the transcript list is still driven by the handler', () => {
    expect(screen).toMatch(/onContentSizeChange=\{handleContentSizeChange\}/);
  });

  test('a different thread starts the coalescer over, so a shorter thread still follows to the bottom', () => {
    expect(screen).toMatch(
      /autoScrollRef\.current = INITIAL_AUTO_SCROLL;\n\s*\}, \[spendSurfaceKey, currentSessionId\]\);/,
    );
  });
});
