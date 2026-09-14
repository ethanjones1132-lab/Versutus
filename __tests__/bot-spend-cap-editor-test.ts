jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import { parseSpendCapInput } from '@/lib/settings/spend-cap-verdict';
import {
  loadBotSpendCap,
  setBotSpendCap,
  spendCapVerdict,
  SPEND_CAP_LIMIT_COPY,
} from '@/lib/settings/bot-spend-cap';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readOverflowSheet(): string {
  return readSource(['src', 'components', 'chat', 'chat-overflow-sheet.tsx']);
}

describe('parseSpendCapInput (the cap row editor fold, in src/lib so the sheet can import it raw)', () => {
  test('a plain number parses as its value', () => {
    expect(parseSpendCapInput('5')).toBe(5);
  });

  test('a dollar sign and interior commas strip — the formats people type', () => {
    expect(parseSpendCapInput('$2.50')).toBe(2.5);
    expect(parseSpendCapInput('1,200')).toBe(1200);
  });

  test('whitespace trims before the number reads', () => {
    expect(parseSpendCapInput('  15 ')).toBe(15);
  });

  test('a blank or whitespace-only answer is null — no cap', () => {
    expect(parseSpendCapInput('')).toBeNull();
    expect(parseSpendCapInput('   ')).toBeNull();
  });

  test('a negative or non-finite answer parses to null — never to a policy', () => {
    expect(parseSpendCapInput('-1')).toBeNull();
    expect(parseSpendCapInput('NaN')).toBeNull();
  });
});

describe('the fold composes with the shipped store (the parents wire both, not a third path)', () => {
  test('a parsed cap writes under the Bot-scoped key', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    const cap = parseSpendCapInput('$2.50');
    await setBotSpendCap('bot-1', cap);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('versutus:spend-cap:bot-1', '2.5');
  });

  test('a blank answer clears the key — the same set(null, ...) path the store already ships', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockClear();
    await setBotSpendCap('bot-1', parseSpendCapInput(''));
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('versutus:spend-cap:bot-1');
  });

  test('a parsed round-trip through the store reads back stable', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('2.5');
    const cap = parseSpendCapInput('$2.50');
    await setBotSpendCap('bot-1', cap);
    await expect(loadBotSpendCap('bot-1')).resolves.toBe(2.5);
  });

  test('the verdict still pauses a run over a cap set by this editor (the pre-run gate keeps its meaning)', () => {
    const cap = parseSpendCapInput('$5');
    expect(cap).toBe(5);
    expect(spendCapVerdict(cap, 5)).toEqual({
      decision: 'pause-and-escalate',
      reason: 'cap-met',
      spendUsd: 5,
      capUsd: 5,
    });
  });
});

describe('Spend cap row (Chat overflow sheet, source pins — the render gates and copy stay on the tree)', () => {
  test('the row renders only when the scoped-spend read is advertised (the capability gate is load-bearing)', () => {
    const sheet = readOverflowSheet();
    expect(sheet).toContain('spendCapBotId && onSetSpendCap');
    expect(sheet).toMatch(/spendCap[A-Z]/g);
  });

  test('the row carries the Bot id, the parsed input fold, and the honest-limit copy under the cap', () => {
    const sheet = readOverflowSheet();
    expect(sheet).toContain('spendCapBotId');
    expect(sheet).toContain('parseSpendCapInput');
    expect(sheet).toContain('SPEND_CAP_LIMIT_COPY');
  });

  test('the editor drives the parent onSetSpendCap callback (never a raw store call from the sheet)', () => {
    const sheet = readOverflowSheet();
    expect(sheet).toContain('onSetSpendCap');
  });

  test('the honest-limit copy names the client-side-only limit verbatim (D5)', () => {
    expect(SPEND_CAP_LIMIT_COPY).toContain('no server-side quota');
  });

  test('the slash executor keeps importing the raw module — pinned so the editor path cannot quietly regress it', () => {
    const slashSource = readSource(['src', 'lib', 'gateway', 'slash-commands.ts']);
    expect(slashSource).toContain('spendCapNoticeCopy');
  });
});

describe('the executor import stays module-loadable without native AsyncStorage (the iter-002 lesson)', () => {
  test('executeGatewaySlashCommand runs /help from a suite that mocks storage', async () => {
    const result = await executeGatewaySlashCommand('/help', {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
    });
    expect(result).toBeDefined();
    expect(typeof result.text).toBe('string');
  });
});
