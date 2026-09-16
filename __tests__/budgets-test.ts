import { keyValueStorage } from '@/lib/storage/key-value';
import {
  BUDGETS_STORAGE_KEY,
  botBudget,
  botSpendFromSessions,
  budgetKey,
  budgetRowCopy,
  budgetsFromUnknown,
  checkBotBudget,
  evaluateBudget,
  loadBudgets,
  parseSpendCapInput,
  saveBudgets,
  setBotBudget,
} from '@/lib/gateway/budgets';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;

describe('budget keys and storage', () => {
  test('a budget is keyed by gateway and Bot, path-safe', () => {
    expect(budgetKey('gw-1', 'scout')).toBe('gw-1:scout');
    expect(budgetKey('gw-1', 'a/b\\c:d')).toBe('gw-1:a_b_c_d');
    expect(BUDGETS_STORAGE_KEY).toBe('versutus:bot-budgets');
  });

  test('a cap must be a positive finite number; clearing removes the entry', () => {
    const budgets = setBotBudget({}, 'gw-1', 'scout', 5);
    expect(botBudget(budgets, 'gw-1', 'scout')).toBe(5);
    expect(botBudget(setBotBudget(budgets, 'gw-1', 'scout', 0), 'gw-1', 'scout')).toBeUndefined();
    expect(setBotBudget({}, 'gw-1', 'scout', Number.NaN)).toEqual({});
    expect(setBotBudget({}, 'gw-1', 'scout', -1)).toEqual({});
  });

  test('the cap set round-trips through key-value storage, and junk reads as none', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ 'gw-1:scout': 5, 'gw-1:junk': 'x' }));
    expect(await loadBudgets()).toEqual({ 'gw-1:scout': 5 });

    await saveBudgets({ 'gw-1:scout': 5 });
    expect(mockSet).toHaveBeenCalledWith(
      'versutus:bot-budgets',
      JSON.stringify({ 'gw-1:scout': 5 }),
    );

    mockGet.mockRejectedValue(new Error('offline'));
    expect(await loadBudgets()).toEqual({});
  });

  test('the cap parses as people type it: plain, with a dollar sign, with thousands commas', () => {
    expect(parseSpendCapInput('5')).toBe(5);
    expect(parseSpendCapInput('7.25')).toBeCloseTo(7.25);
    expect(parseSpendCapInput('$5')).toBe(5);
    expect(parseSpendCapInput('1,500')).toBe(1500);
    expect(parseSpendCapInput('$1,500.00')).toBe(1500);
    expect(parseSpendCapInput('  5  ')).toBe(5);
    expect(parseSpendCapInput('')).toBeUndefined();
    expect(parseSpendCapInput('nope')).toBeUndefined();
    expect(parseSpendCapInput('-3')).toBeUndefined();
    expect(parseSpendCapInput('0')).toBeUndefined();
  });

  test('the row copy names the cap or says there is none', () => {
    expect(budgetRowCopy(5)).toBe('Budget $5.00');
    expect(budgetRowCopy(undefined)).toBe('No budget');
  });

  test('a scoped sessions payload folds to the Bot cost the Spend surface prints', () => {
    const payload = {
      object: 'list',
      data: [{ input_tokens: 100, output_tokens: 900, actual_cost_usd: 1.25 }],
    };
    expect(botSpendFromSessions('scout', payload)).toBeCloseTo(1.25);
    expect(botSpendFromSessions('scout', { object: 'list', data: [] })).toBe(0);
    expect(botSpendFromSessions('scout', 'nope')).toBe(0);
  });

  test('a junk store reads as no budgets', () => {
    expect(budgetsFromUnknown({ 'gw-1:scout': 5, 'gw-1:night': 'x', 'gw-1:bad': -2 })).toEqual({
      'gw-1:scout': 5,
    });
    expect(budgetsFromUnknown(null)).toEqual({});
    expect(budgetsFromUnknown([1, 2])).toEqual({});
  });
});

describe('the budget verdict', () => {
  test('under an absent cap, or exactly at it, allows', () => {
    expect(evaluateBudget(undefined, 100)).toEqual({ allowed: true });
    expect(evaluateBudget(5, null)).toEqual({ allowed: true, cap: 5, spent: 0 });
    expect(evaluateBudget(5, 5)).toEqual({ allowed: true, cap: 5, spent: 5 });
  });

  test('over cap refuses with a named reason and the amount over', () => {
    const verdict = evaluateBudget(5, 7.5);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.overBy).toBeCloseTo(2.5);
    expect(verdict.reason).toContain('7.50');
    expect(verdict.reason).toContain('5.00');
  });

  test('the refusal says the run did not start, the cap stands, and its scope', () => {
    const verdict = evaluateBudget(5, 7.5);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain('not started');
      expect(verdict.reason).toContain('cap stands');
      expect(verdict.reason).toContain('runs started from this app');
    }
  });

  test('checkBotBudget allows when there is no cap, or the spend read is unknown', async () => {
    expect(
      await checkBotBudget({
        budgets: {},
        gatewayId: 'gw-1',
        botId: 'scout',
        readSpend: async () => 999,
      }),
    ).toEqual({ allowed: true });

    const unknown = await checkBotBudget({
      budgets: { 'gw-1:scout': 5 },
      gatewayId: 'gw-1',
      botId: 'scout',
      readSpend: async () => {
        throw new Error('offline');
      },
    });
    // Unknown is not "over": the read failed, so the run is allowed and the cap is named.
    expect(unknown.allowed).toBe(true);

    const over = await checkBotBudget({
      budgets: { 'gw-1:scout': 5 },
      gatewayId: 'gw-1',
      botId: 'scout',
      readSpend: async () => 6,
    });
    expect(over.allowed).toBe(false);
  });
});

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

describe('the cap editor and the pre-run hard stop are wired', () => {
  test('the Spend section carries the cap editor', () => {
    const section = readSource('src', 'components', 'gateway', 'spend-per-bot-section.tsx');
    expect(section).toContain('budgetRowCopy(cap)');
    expect(section).toContain('onSetBudget');
  });

  test('the Spend screen owns the cap store', () => {
    const screen = readSource('src', 'app', 'gateway', 'spend.tsx');
    expect(screen).toContain('loadBudgets()');
    expect(screen).toContain('saveBudgets(next)');
    expect(screen).toContain('onSetBudget={activeGateway ? handleSetBudget : undefined}');
  });

  test('runTask checks the cap before it starts the run', () => {
    const provider = readSource('src', 'context', 'gateway-provider.tsx');
    const guard = provider.indexOf('checkBotBudget({');
    const run = provider.indexOf('executeRun(runCapable');
    expect(guard).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(guard);
    expect(provider).toContain('botSpendFromSessions(');
  });
});
