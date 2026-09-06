import {
  applySessionSpendRead,
  EMPTY_SESSION_SPEND,
  sessionSpendReadFromUnknown,
  threadSpendCopy,
} from '@/lib/gateway/session-analytics';

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

describe('thread spend retry', () => {
  test('the failed first read offers a Retry action wired to the retry callback', () => {
    // A failed first read left the operator with the micro copy and no way
    // forward — the spend refresh key is fully derived, so no existing
    // gesture re-reads it. The glance now renders a retry button bound to
    // the re-read callback the thread owns.
    const src = readSource('src', 'components', 'chat', 'thread-spend-glance.tsx');
    expect(src).toContain('onRetry');
    const failed = src.match(/\{onRetry \? <Button[\s\S]*?\/> : null\}/)?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/variant="ghost"/);
    expect(failed).toMatch(/onPress=\{onRetry\}/);
  });

  test('the retry is offered only when the screen passes a callback, never alone', () => {
    // The glance owns no fetch and reads no state — exactly one Retry
    // affordance exists, rendered only when a retry callback arrives, so no
    // button renders over the success glance or its stale-total copy.
    const src = readSource('src', 'components', 'chat', 'thread-spend-glance.tsx');
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(src).toContain('onRetry?: () => void');
  });

  test('the failed-first-read micro copy still names the failure', () => {
    const src = readSource('src', 'components', 'chat', 'thread-spend-glance.tsx');
    expect(src).toContain('{copy}');
    expect(threadSpendCopy({ sessions: [], loaded: false, failed: true }, 's1')).toBe(
      'Spend could not be read.',
    );
  });

  test('a failed re-read keeps the last good total with its stale copy', () => {
    // The lib keeps the two failures distinct: retrying over a loaded list
    // must never clear it, so the Retry path cannot strand the operator
    // with less than they had. The stale copy names the thread the read
    // can no longer find; a thread still in the list keeps its total.
    const loaded = {
      sessions: [{ id: 's1', input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.42 }],
      loaded: true,
      failed: false,
    };
    const next = applySessionSpendRead(loaded, { ok: false });
    expect(next).toEqual({ sessions: loaded.sessions, loaded: true, failed: true });
    expect(threadSpendCopy(next, 'gone')).toBe(
      'Could not re-read spend — showing the last total.',
    );
    expect(threadSpendCopy(next, 's1')).toBe('150 · $0.42');
  });

  test('a failed first read never renders as an empty glance', () => {
    // A junk envelope parses as a failed read, never an empty-ok list, so
    // the glance cannot go silent when it knows nothing.
    const read = sessionSpendReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applySessionSpendRead(EMPTY_SESSION_SPEND, read);
    expect(threadSpendCopy(state, 's1')).toBe('Spend could not be read.');
  });

  test('the success glance still renders the token · cost copy byte-identical', () => {
    // The Retry affordance must not touch what the glance shows when the
    // read lands: tokens, a middle dot, then cost or an em dash.
    const state = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 1500, output_tokens: 0, actual_cost_usd: 0.42 }],
    });
    expect(threadSpendCopy(state, 's1')).toBe('1.5k · $0.42');
  });

  test('chat-screen wires the retry through a tick folded into the spend key', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('handleSpendRetry');
    // The tick is the only non-derived key input: bumping it re-runs the
    // spend effect with the same `sessions.list` read.
    expect(screen).toMatch(/spendRetryTick/);
    expect(screen).toMatch(/spendEffectKey/);
    expect(screen).toMatch(/setSpendRetryTick\(\(tick\) => tick \+ 1\)/);
    // The retry reaches the glance only on the failed-first-read state —
    // never over the success glance or the stale-total copy.
    expect(screen).toMatch(
      /spendState\.surfaceKey === spendSurfaceKey && !spendState\.loaded && spendState\.failed\s*\?\s*handleSpendRetry\s*:\s*undefined/,
    );
  });
});
