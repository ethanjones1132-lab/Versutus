import {
  addStreamingPlaceholder,
  appendStreamDelta,
  preserveTurnBubbleAfterReload,
} from '@/lib/gateway/message-reducer';

// MODEL-2 / V-1: a model pick, a thread switch, a New session and a delete all
// replaced the message list while a reply was streaming, so every remaining
// delta found no placeholder and was discarded. The fix carries the live
// bubble across each replacement with `preserveTurnBubbleAfterReload` (the same
// helper the reload path already uses). These tests model exactly that:
//   before -> a replacement built only from new content loses the bubble;
//   after  -> preserving it keeps the deltas.

describe('a live reply survives a mid-turn list replacement', () => {
  test('without preserving, the replacement drops the streaming bubble and the delta', () => {
    const started = addStreamingPlaceholder([], 'run-1');
    const first = appendStreamDelta(started, 'run-1', 'Roses are ');
    expect(first.some((m) => m.id === 'run-run-1')).toBe(true);

    // A full replacement (setMessages([]) / a fresh system note / reloaded
    // history) — the buggy path.
    const replaced = [{ id: 'note', role: 'system' as const, text: 'New session opened.', timestamp: 0 }];
    const afterDelta = appendStreamDelta(replaced, 'run-1', 'red');
    // The delta is silently discarded: this is the defect.
    expect(afterDelta).toEqual(replaced);
    expect(afterDelta.some((m) => m.id === 'run-run-1')).toBe(false);
  });

  test('the preserved bubble keeps the reply and receives later deltas', () => {
    const started = addStreamingPlaceholder([], 'run-1');
    const first = appendStreamDelta(started, 'run-1', 'Roses are ');
    const replacement = [{ id: 'note', role: 'system' as const, text: 'New session opened.', timestamp: 0 }];

    const carried = preserveTurnBubbleAfterReload(replacement, first, 'run-1');
    expect(carried.some((m) => m.id === 'run-run-1')).toBe(true);
    const afterDelta = appendStreamDelta(carried, 'run-1', 'red');
    const bubble = afterDelta.find((m) => m.id === 'run-run-1');
    expect(bubble?.text).toBe('Roses are red');
  });

  test('the provider carries the live run across selectModel, selectSession, createNewSession and delete', () => {
    const src = providerSource();
    // paintThread, selectModel, createNewSession, deleteSessionById each carry
    // the live run; selectSession's carry comes via the reload path.
    expect(src.match(/const liveRunId = activeRunIdRef\.current;/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(src.match(/preserveTurnBubbleAfterReload\([^;]*liveRunId/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test('the reload path also carries the live chat bubble, not just followed turns', () => {
    const src = providerSource();
    const paint = src.slice(src.indexOf('const paintThread = (gatewayHistory'), src.indexOf('setMessages(boundWindow(merged));'));
    expect(paint).toContain('preserveTurnBubbleAfterReload(merged, previous, turnId)');
    expect(paint).toContain('const liveRunId = activeRunIdRef.current;');
    expect(paint).toMatch(/if \(liveRunId\) merged = preserveTurnBubbleAfterReload\(merged, previous, liveRunId\);/);
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function providerSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}
