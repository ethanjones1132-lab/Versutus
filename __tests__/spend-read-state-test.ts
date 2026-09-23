// ─── Spend read states ─────────────────────────────────────────────────────
// The Spend screen folds one sessions.list read into every number it shows,
// so the read's own state must read honestly: in flight is a Skeleton, a
// refusal is an ErrorCard that keeps the caught cause and offers a Retry, and
// a disconnected screen is an EmptyState naming the wait — never one bare
// caption standing in for all three, and never a stale re-read failure as the
// dimmest gray on screen. Pinned off the source so a restyle that swallows
// the message again or collapses the branches fails here, not on the phone.

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

const spend = () => readSource('src', 'app', 'gateway', 'spend.tsx');

describe('the catalogue read keeps the caught cause', () => {
  test('the screen holds a readError beside the spend state', () => {
    expect(spend()).toContain('const [readError, setReadError] = useState<string | null>(null)');
  });

  test('the refusal stores the caught message instead of discarding it', () => {
    // The old catch folded every rejection into { ok: false } and dropped the
    // Error, so the failure surface had no cause to render and no retry to
    // offer — recovery meant leaving the screen.
    expect(spend()).toContain(
      'setReadError(caught instanceof Error ? caught.message : String(caught))',
    );
  });

  test('a completed read clears the previous cause', () => {
    expect(spend()).toContain('setReadError(null)');
  });

  test('both settle arms guard the unmount the effect already guards', () => {
    const src = spend();
    expect(src.match(/if \(isCancelled\(\)\) return;/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('loading, failed, and disconnected are three different surfaces', () => {
  test('a connected first read in flight is a Skeleton, not a bare caption', () => {
    const src = spend();
    expect(src).toContain('<Skeleton');
    expect(src).not.toContain('Reading spend…');
  });

  test('a failed read is an ErrorCard that keeps the cause and offers a Retry', () => {
    const src = spend();
    expect(src).toMatch(/\{state\.failed \? \(\s*<ErrorCard/);
    expect(src).toContain('cause={readError ?? SPEND_UNREAD_COPY}');
    expect(src).toContain('affected=');
    expect(src).toContain('next=');
    expect(src).toContain('onRetry={retrySpendRead}');
  });

  test('a disconnected screen with nothing loaded is an EmptyState naming the wait', () => {
    const src = spend();
    expect(src).toMatch(/status !== 'connected' \? \(\s*<EmptyState/);
    // The old ternary printed both "Reading spend…" and the connect sentence
    // as one caption in the hero slot; neither survives.
    expect(src).not.toContain('Connect a gateway to read its spend.');
  });

  test('the branch chain leads with the loaded total, then failed, then connection', () => {
    const src = spend();
    expect(src).toMatch(/state\.loaded \? \(/);
    expect(src).toMatch(/state\.failed \? null : status !== 'connected'/);
  });
});

describe('a stale re-read failure surfaces where the tertiary caption was', () => {
  test('the hero keeps the last total under state.loaded alone', () => {
    // applySessionSpendRead retains the last good list on a failed re-read;
    // the hero must still render it — the failure announces itself through
    // the ErrorCard below, not by hiding the number.
    const src = spend();
    expect(src).toMatch(/state\.loaded \? \(/);
    expect(src).not.toContain('state.loaded && !state.failed');
  });

  test('the dimmest-gray caption is gone', () => {
    expect(spend()).not.toContain('Could not re-read spend — showing the last total.');
  });
});

describe('retry recovers without leaving the screen', () => {
  test('retry re-reads while connected and reconnects otherwise', () => {
    const src = spend();
    expect(src).toContain('const retrySpendRead = () =>');
    expect(src).toContain("if (status === 'connected')");
    expect(src).toContain('loadSpend(() => false)');
    expect(src).toContain('retryAutoConnect');
  });
});

describe('what must keep working', () => {
  test('the one catalogue read, its gate, and the fold are untouched', () => {
    const src = spend();
    expect(src.match(/gatewayRequest\('sessions\.list'/g)).toHaveLength(1);
    expect(src).toContain(
      "gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT })",
    );
    expect(src).toContain("if (status !== 'connected') return;");
    expect(src).toContain('applySessionSpendRead(');
    expect(src).toContain('sessionSpendReadFromUnknown(');
  });

  test('the total still renders only off a loaded read, then chart, per-Bot, table', () => {
    const src = spend();
    const total = src.indexOf('{sessionSpendCopy(spend)}');
    const chart = src.indexOf('<SpendChart');
    const perBot = src.indexOf('<SpendPerBotSection');
    const table = src.indexOf('<SpendSessionTable');
    expect(src.indexOf('state.loaded ? (')).toBeGreaterThanOrEqual(0);
    expect(total).toBeGreaterThan(src.indexOf('state.loaded ? ('));
    expect(chart).toBeGreaterThan(total);
    expect(perBot).toBeGreaterThan(chart);
    expect(table).toBeGreaterThan(perBot);
    expect(src).toContain('state.loaded ? <SpendChart');
  });

  test('the per-Bot read keeps its own catch contract and the cap store stays', () => {
    const src = spend();
    const readAt = src.indexOf('readBotSpend(');
    const catchAt = src.indexOf('.catch(() => {', readAt);
    expect(catchAt).toBeGreaterThan(readAt);
    const failureBranch = src.slice(catchAt, src.indexOf('});', catchAt));
    expect(failureBranch).toContain('setBotReport(null);');
    expect(failureBranch).not.toContain('rows:');
    expect(src).toContain('loadBudgets()');
    expect(src).toContain('saveBudgets(next)');
    expect(src).toContain('onSetBudget={activeGateway ? handleSetBudget : undefined}');
  });
});
