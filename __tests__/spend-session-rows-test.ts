import {
  SESSION_SPEND_LIST_LIMIT,
  spendWindowCopy,
  weekBuckets,
  type SessionUsageInput,
} from '@/lib/gateway/session-analytics';
import {
  botSpendRowCopy,
  spendSessionCapCopy,
  spendSessionRowCopy,
  spendSessionRows,
} from '@/lib/gateway/spend-report';

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

const table = () => readSource('src', 'components', 'gateway', 'spend-session-table.tsx');
const spendScreen = () => readSource('src', 'app', 'gateway', 'spend.tsx');

// P5's last section: the per-session table, over the same 200-row catalogue
// read the gateway total already folded. This suite pins the sort (biggest
// cost first, cost-less rows last, stable on ties), the label fallback, the
// recency the read carried, the basis on every number, and the bound the
// table is bound to name.
describe('the table is the catalogue read, sorted by what each session spent', () => {
  test('the biggest cost is the first row', () => {
    const rows = spendSessionRows([
      { id: 'a', input_tokens: 10, actual_cost_usd: 0.5 },
      { id: 'b', input_tokens: 10, actual_cost_usd: 9 },
      { id: 'c', input_tokens: 10, actual_cost_usd: 2 },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['b', 'c', 'a']);
  });

  test('equal costs keep the read order rather than reshuffling every render', () => {
    const rows = spendSessionRows([
      { id: 'first', actual_cost_usd: 1 },
      { id: 'second', actual_cost_usd: 1 },
      { id: 'third', actual_cost_usd: 1 },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['first', 'second', 'third']);
  });

  test('a session with no readable cost goes below every costed one', () => {
    const rows = spendSessionRows([
      { id: 'unknown', input_tokens: 900 },
      { id: 'cheap', actual_cost_usd: 0.01 },
      { id: 'free', actual_cost_usd: 0 },
    ]);
    // A zero cost IS a cost; only an unreadable one is unknown.
    expect(rows.map((row) => row.label)).toEqual(['cheap', 'free', 'unknown']);
  });

  test('two cost-less sessions keep the read order too', () => {
    const rows = spendSessionRows([
      { id: 'x', input_tokens: 1 },
      { id: 'y', input_tokens: 2 },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['x', 'y']);
  });

  test('the tokens are the input and output this read carried, summed', () => {
    const row = spendSessionRows([{ id: 'a', input_tokens: 1200, output_tokens: 34 }])[0];
    expect(row.tokens).toBe(1234);
  });
});

describe('an empty read is no table', () => {
  test('no sessions fold to no rows', () => {
    expect(spendSessionRows([])).toEqual([]);
  });

  test('the table renders nothing at all rather than an empty list', () => {
    expect(table()).toContain('if (rows.length === 0) return null;');
  });
});

describe('a row is named, and never invents a recency', () => {
  test('the session id is the label', () => {
    expect(spendSessionRows([{ id: 'sess-7', input_tokens: 1 }])[0].label).toBe('sess-7');
  });

  test('a session the read gave no id reads as Untitled, the selector word', () => {
    const rows = spendSessionRows([{ input_tokens: 4 }, { input_tokens: 5 }]);
    expect(rows.map((row) => row.label)).toEqual(['Untitled', 'Untitled']);
    // Two unnamed rows are still two rows: no list key may collide.
    expect(rows[0].key).not.toBe(rows[1].key);
  });

  test('a blank id is no id', () => {
    expect(spendSessionRows([{ id: '   ', input_tokens: 1 }])[0].label).toBe('Untitled');
  });

  test('last_active in seconds is normalised to the milliseconds the formatter reads', () => {
    const lastActive = 1_700_000_000;
    const row = spendSessionRows([{ id: 'a', input_tokens: 1, last_active: lastActive }])[0];
    expect(row.lastActiveMs).toBe(lastActive * 1000);
  });

  test('a row with no timestamp prints no recency, which is not "just now"', () => {
    const row = spendSessionRows([{ id: 'a', input_tokens: 1 }])[0];
    expect(row.lastActiveMs).toBeNull();
    expect(spendSessionRowCopy(row)).toBe('1 tokens · no cost fields in this read');
  });

  test('a row with a timestamp prints how long ago it ran', () => {
    const twoHoursAgo = Math.floor((Date.now() - 7_200_000) / 1000);
    const row = spendSessionRows([
      { id: 'a', input_tokens: 1200, actual_cost_usd: 0.9, last_active: twoHoursAgo },
    ])[0];
    expect(spendSessionRowCopy(row)).toBe('1.2k tokens · $0.90 (actual) · 2h ago');
  });
});

describe('every row carries the basis its number is claimed on', () => {
  test('an actual charge reads as actual', () => {
    const row = spendSessionRows([{ id: 'a', input_tokens: 10, actual_cost_usd: 2 }])[0];
    expect(row.basis).toBe('actual');
    expect(spendSessionRowCopy(row)).toContain('(actual)');
  });

  test('an estimate reads as estimated, never as a bill', () => {
    const row = spendSessionRows([{ id: 'a', input_tokens: 10, estimated_cost_usd: 2 }])[0];
    expect(row.basis).toBe('estimated');
    expect(spendSessionRowCopy(row)).toContain('(estimated)');
  });

  test('a read that carried no cost fields shows tokens and says why there is no cost', () => {
    const row = spendSessionRows([{ id: 'a', input_tokens: 10, output_tokens: 5 }])[0];
    expect(row.costUsd).toBeNull();
    expect(row.basis).toBe('none');
    expect(spendSessionRowCopy(row)).toContain('no cost fields in this read');
  });
});

describe('the cap is named, never silently truncated', () => {
  test('a full read says the list is capped and older sessions are past it', () => {
    expect(spendSessionCapCopy(SESSION_SPEND_LIST_LIMIT)).toBe(
      `Newest ${SESSION_SPEND_LIST_LIMIT} sessions — older sessions are past the list's cap`,
    );
  });

  test('a partial read names its own count and claims no truncation', () => {
    expect(spendSessionCapCopy(3)).toBe('3 sessions in this read');
    expect(spendSessionCapCopy(3)).not.toMatch(/cap|older/);
  });

  test('the bound is the shared constant, and the table renders it', () => {
    expect(SESSION_SPEND_LIST_LIMIT).toBe(200);
    expect(table()).toContain('{spendSessionCapCopy(rows.length)}');
  });
});

describe('the table paints the shipped folds and aggregates nothing itself', () => {
  test('every string on it comes from the module that decided it', () => {
    const src = table();
    expect(src).toContain("from '@/lib/gateway/spend-report'");
    expect(src).toContain('{spendSessionRowCopy(row)}');
    expect(src).toContain('{spendSessionCapCopy(rows.length)}');
  });

  test('no number is computed on the table', () => {
    const src = table();
    expect(src).not.toContain('totalUsage');
    expect(src).not.toContain('sessionUsage');
    expect(src).not.toContain('formatCost');
    expect(src).not.toContain('formatTokenCount');
  });
});

describe('the screen lists the sessions out of the read it already made', () => {
  test('the rows are the catalogue the total folded — no second fetch', () => {
    const src = spendScreen();
    expect(src.match(/gatewayRequest\('sessions\.list'/g)).toHaveLength(1);
    expect(src).toContain('spendSessionRows(state.sessions)');
    expect(src).toContain('<SpendSessionTable');
    expect(src).not.toContain('gatewayFetch(');
  });
});

describe('what must keep working', () => {
  test('a Bot row still prints the tokens, the cost and its basis', () => {
    expect(
      botSpendRowCopy({ botId: 'a', label: 'A', basis: 'actual', tokens: 1200, costUsd: 0.9, failed: false }),
    ).toBe('1.2k tokens · $0.90 (actual)');
    expect(
      botSpendRowCopy({ botId: 'a', label: 'A', basis: 'none', tokens: 340, costUsd: null, failed: false }),
    ).toBe('340 tokens · no cost fields in this read');
  });

  test('the window line is untouched for the sparkline and the chart', () => {
    expect(spendWindowCopy(3)).toBe('Last 7 days · recent sessions');
    expect(spendWindowCopy(SESSION_SPEND_LIST_LIMIT)).toBe('Last 7 days · newest 200 sessions');
  });

  test('weekBuckets still folds the same seven days', () => {
    const empty: SessionUsageInput[] = [];
    expect(weekBuckets(empty, 1_700_000_000_000)).toHaveLength(7);
  });
});
