import {
  botSpendRows,
  botSpendRowCopy,
  spendBasisCopy,
  spendCostBasis,
  SPEND_UNREAD_COPY,
  type BotSpendRead,
  type SpendCostBasis,
} from '@/lib/gateway/spend-report';
import type { SessionUsageInput } from '@/lib/gateway/session-analytics';

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

const ok = (...sessions: SessionUsageInput[]): BotSpendRead['read'] => ({
  ok: true,
  sessions,
});

describe('spendCostBasis', () => {
  test('a read of billed sessions is actual', () => {
    expect(spendCostBasis([{ actual_cost_usd: 0.4 }, { input_tokens: 10, actual_cost_usd: 0.1 }])).toBe(
      'actual',
    );
  });

  test('estimate-only sessions are estimated', () => {
    expect(spendCostBasis([{ estimated_cost_usd: 0.4 }, { input_tokens: 10 }])).toBe('estimated');
  });

  test('a mix is estimated — the weaker claim, never the stronger', () => {
    expect(spendCostBasis([{ actual_cost_usd: 0.4 }, { estimated_cost_usd: 0.2 }])).toBe('estimated');
  });

  test('a session carrying both counts as actual, the way sessionUsage reads it', () => {
    expect(spendCostBasis([{ actual_cost_usd: 0.4, estimated_cost_usd: 9 }])).toBe('actual');
  });

  test('a null actual falls through to the estimate beside it', () => {
    expect(spendCostBasis([{ actual_cost_usd: null, estimated_cost_usd: 0.5 }])).toBe('estimated');
  });

  test('no cost field anywhere is none — zero knowledge, not $0.00 of spend', () => {
    expect(spendCostBasis([{ input_tokens: 10, output_tokens: 5 }])).toBe('none');
    expect(spendCostBasis([])).toBe('none');
  });

  test('a non-finite cost is no cost at all', () => {
    expect(spendCostBasis([{ actual_cost_usd: Number.NaN }])).toBe('none');
    expect(
      spendCostBasis([{ actual_cost_usd: Number.POSITIVE_INFINITY, estimated_cost_usd: Number.NaN }]),
    ).toBe('none');
  });
});

describe('spendBasisCopy', () => {
  test('an actual header names the basis', () => {
    expect(spendBasisCopy('actual')).toBe('Costs shown are actual charges');
  });

  test('an estimated header says estimated and claims no bill', () => {
    expect(spendBasisCopy('estimated')).toContain('estimated');
    expect(spendBasisCopy('estimated')).not.toMatch(/bill|billed|charged/i);
  });

  test('a cost-less header says why, in tokens', () => {
    expect(spendBasisCopy('none')).toContain('Tokens');
    expect(spendBasisCopy('none')).toContain('no cost fields');
  });

  test('no header prints a number — the header is not a total', () => {
    for (const basis of ['actual', 'estimated', 'none'] as SpendCostBasis[]) {
      expect(spendBasisCopy(basis)).not.toMatch(/[\d$]/);
    }
  });
});

describe('botSpendRows', () => {
  test('one row per Bot, biggest spend first, cost-less rows last', () => {
    const rows = botSpendRows([
      { botId: 'nokey', read: ok({ input_tokens: 5 }) },
      { botId: 'small', read: ok({ input_tokens: 10, actual_cost_usd: 0.1 }) },
      { botId: 'big', read: ok({ input_tokens: 30, actual_cost_usd: 2.5 }) },
    ]);
    expect(rows.map((row) => row.botId)).toEqual(['big', 'small', 'nokey']);
    expect(rows[0]).toEqual({
      botId: 'big',
      label: 'big',
      basis: 'actual',
      tokens: 30,
      costUsd: 2.5,
      failed: false,
    });
  });

  test('equal costs keep roster order — the tie is not a reshuffle', () => {
    const rows = botSpendRows([
      { botId: 'first', read: ok({ actual_cost_usd: 0.5 }) },
      { botId: 'second', read: ok({ actual_cost_usd: 0.5 }) },
      { botId: 'third', read: ok({ actual_cost_usd: 0.5 }) },
    ]);
    expect(rows.map((row) => row.botId)).toEqual(['first', 'second', 'third']);
  });

  test('a failed read is a named row that never prints a zero', () => {
    const rows = botSpendRows([{ botId: 'hermes', label: 'Hermes', read: { ok: false } }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      botId: 'hermes',
      label: 'Hermes',
      basis: null,
      tokens: null,
      costUsd: null,
      failed: true,
    });
    expect(botSpendRowCopy(rows[0])).toBe(SPEND_UNREAD_COPY);
    expect(botSpendRowCopy(rows[0])).toBe('Spend could not be read.');
    expect(botSpendRowCopy(rows[0])).not.toMatch(/[\d$]/);
  });

  test('a failed read sorts with the other cost-less rows, after every costed one', () => {
    const rows = botSpendRows([
      { botId: 'broken', read: { ok: false } },
      { botId: 'billed', read: ok({ actual_cost_usd: 1.5 }) },
      { botId: 'ttl-only', read: ok({ input_tokens: 3 }) },
    ]);
    expect(rows.map((row) => row.botId)).toEqual(['billed', 'broken', 'ttl-only']);
  });

  test('an all-estimated read labels every row estimated', () => {
    const rows = botSpendRows([
      { botId: 'a', read: ok({ estimated_cost_usd: 0.2 }) },
      { botId: 'b', read: ok({ estimated_cost_usd: 0.9 }) },
    ]);
    expect(rows.map((row) => row.basis)).toEqual(['estimated', 'estimated']);
    expect(rows.every((row) => botSpendRowCopy(row).includes('estimated'))).toBe(true);
  });

  test('a cost-less catalogue keeps the tokens and names what is missing', () => {
    const rows = botSpendRows([
      { botId: 'a', read: ok({ input_tokens: 100, output_tokens: 50 }) },
    ]);
    expect(rows[0].tokens).toBe(150);
    expect(rows[0].costUsd).toBeNull();
    expect(rows[0].basis).toBe('none');
    expect(botSpendRowCopy(rows[0])).toContain('150 tokens');
    expect(botSpendRowCopy(rows[0])).toContain('no cost fields');
  });

  test('an empty-ok read is a named row of zero tokens, not a failure', () => {
    const rows = botSpendRows([{ botId: 'quiet', read: ok() }]);
    expect(rows[0].failed).toBe(false);
    expect(rows[0].tokens).toBe(0);
    expect(rows[0].costUsd).toBeNull();
    expect(rows[0].basis).toBe('none');
  });

  test('an empty roster is no rows', () => {
    expect(botSpendRows([])).toEqual([]);
  });

  test('a blank or missing label falls back to the Bot id', () => {
    const rows = botSpendRows([
      { botId: 'no-label', read: ok() },
      { botId: 'blank-label', label: '   ', read: ok() },
      { botId: 'named', label: ' Research ', read: ok() },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['no-label', 'blank-label', 'Research']);
  });

  test('a row without a cost never claims one, and basis none means exactly that', () => {
    const rows = botSpendRows([
      { botId: 'costed', read: ok({ actual_cost_usd: 0.01 }) },
      { botId: 'costless', read: ok({ input_tokens: 1 }) },
      { botId: 'broken', read: { ok: false } },
    ]);
    for (const row of rows) {
      // `none` is the cost-less basis: a row claiming it can carry no number,
      // and a row carrying a number can never read as cost-less.
      if (row.basis === 'none') {
        expect(row.costUsd).toBeNull();
        expect(row.tokens).not.toBeNull();
      }
      if (row.costUsd != null) expect(row.basis).not.toBe('none');
    }
    expect(rows.find((row) => row.botId === 'costless')?.costUsd).toBeNull();
    expect(rows.find((row) => row.botId === 'costless')?.costUsd).not.toBe(0);
  });

  test('a costed row carries its basis beside the number, never a bare total', () => {
    const rows = botSpendRows([
      { botId: 'est', read: ok({ estimated_cost_usd: 0.42 }) },
      { botId: 'real', read: ok({ actual_cost_usd: 0.42 }) },
    ]);
    const estimated = rows.find((row) => row.botId === 'est');
    const actual = rows.find((row) => row.botId === 'real');
    expect(estimated).toBeDefined();
    expect(actual).toBeDefined();
    expect(botSpendRowCopy(estimated ?? rows[0])).toContain('(estimated)');
    expect(botSpendRowCopy(actual ?? rows[0])).toContain('(actual)');
    expect(botSpendRowCopy(estimated ?? rows[0])).toContain('$0.42');
  });
});

describe('spend-report reuses the shipped folds', () => {
  test('the per-Bot fold imports sessionUsage and totalUsage instead of re-adding tokens', () => {
    // P5 says the per-Bot breakdown is "N existing reads" folded with the
    // existing helpers — no new aggregation logic. A second token/cost sum
    // living here would drift from the glance the moment either changes.
    const src = readSource('src', 'lib', 'gateway', 'spend-report.ts');
    expect(src).toMatch(/import\s*\{[\s\S]*?\btotalUsage\b[\s\S]*?\}\s*from\s*'@\/lib\/gateway\/session-analytics'/);
    expect(src).toMatch(/import\s*\{[\s\S]*?\bsessionUsage\b[\s\S]*?\}\s*from\s*'@\/lib\/gateway\/session-analytics'/);
  });
});
