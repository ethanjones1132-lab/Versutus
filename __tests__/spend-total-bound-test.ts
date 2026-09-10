import {
  SESSION_SPEND_LIST_LIMIT,
  spendTotalBoundCopy,
  spendWindowCopy,
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

const spendScreen = () => readSource('src', 'app', 'gateway', 'spend.tsx');
const sparkline = () => readSource('src', 'components', 'chat', 'session-analytics.tsx');

// The Spend screen's total is folded from the whole catalogue read — every row
// `sessions.list` answered with, whose age is unbounded — so the sparkline's
// "Last 7 days" window line cannot caption it: a session older than the window
// is inside the number. The total gets its own bound line, naming the cap the
// read stopped at and claiming no window; `spendWindowCopy` stays with the
// 7-day chart (`weekBuckets`) it was written for.
describe("the total names the read it folded, not a 7-day window", () => {
  test('a read that hit the cap says so', () => {
    expect(spendTotalBoundCopy(SESSION_SPEND_LIST_LIMIT)).toBe(
      `Across the newest ${SESSION_SPEND_LIST_LIMIT} sessions — older sessions are past the list's cap`,
    );
    expect(spendTotalBoundCopy(SESSION_SPEND_LIST_LIMIT + 50)).toContain(
      `newest ${SESSION_SPEND_LIST_LIMIT} sessions`,
    );
  });

  test('a partial read names its own count and claims no cap it did not hit', () => {
    expect(spendTotalBoundCopy(7)).toBe('Across the 7 sessions in this read');
    expect(spendTotalBoundCopy(7)).not.toMatch(/cap|older/);
  });

  test('an empty read names itself rather than reading as a window', () => {
    expect(spendTotalBoundCopy(0)).toBe('Across the 0 sessions in this read');
  });

  test('no count this line prints claims a 7-day span', () => {
    for (const count of [0, 7, SESSION_SPEND_LIST_LIMIT, SESSION_SPEND_LIST_LIMIT + 50]) {
      expect(spendTotalBoundCopy(count)).not.toMatch(/7 days|week/i);
    }
  });

  test('an unreadable count prints no number and no cap', () => {
    expect(spendTotalBoundCopy(Number.NaN)).toBe('Across the 0 sessions in this read');
    expect(spendTotalBoundCopy(-4)).toBe('Across the 0 sessions in this read');
  });
});

describe('the screen captions its total from the read, not a window', () => {
  test('the total renders the bound line off the row count, not the rows that parsed', () => {
    const src = spendScreen();
    expect(src).toContain('{spendTotalBoundCopy(state.rowCount)}');
  });

  test('the window line no longer captions the total', () => {
    // A comment may still name it; what must not survive is the call.
    expect(spendScreen()).not.toContain('spendWindowCopy(');
  });
});

describe('what must keep working', () => {
  test('the window line is untouched for the sparkline and the chart', () => {
    expect(spendWindowCopy(3)).toBe('Last 7 days · recent sessions');
    expect(spendWindowCopy(SESSION_SPEND_LIST_LIMIT)).toBe(
      `Last 7 days · newest ${SESSION_SPEND_LIST_LIMIT} sessions`,
    );
  });

  test('the 7-day sparkline still captions with the window line', () => {
    expect(sparkline()).toContain('spendWindowCopy(rowCount)');
  });

  test('the total is still one catalogue read, and the table still names it', () => {
    const src = spendScreen();
    expect(src.match(/gatewayRequest\('sessions\.list'/g)).toHaveLength(1);
    expect(src).toContain('{sessionSpendCopy(spend)}');
    expect(src).toContain('rowCount={state.rowCount}');
  });
});
