import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import {
  SESSION_SPEND_LIST_LIMIT,
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

/**
 * The spend glance folds a `sessions.list` window, not the catalogue: the
 * chat overflow sheet meters the open thread against 7-day buckets built
 * from that window (`chat-screen.tsx` spend effect), and `/usage` totals
 * the same window (`runSessionSpendCommand`). A filled window may be
 * truncated — the list endpoint takes `limit` but no cursor — so both
 * surfaces must name the bound instead of reading as the whole catalogue.
 * The per-thread glance itself still comes from list rows: a failed read
 * keeps today's copies, never zeros.
 *
 * Both bound lines decide from the read's ROW count
 * (`SessionSpendRead.rowCount`), never the rows that parsed: a row with
 * nothing to parse is dropped from the fold, so a 200-row window carrying
 * one such row would otherwise read as 199 sessions and name no bound.
 */
describe('spend window limit', () => {
  test('covers the catalogue-wide read the Gate totals', () => {
    expect(Number.isInteger(SESSION_SPEND_LIST_LIMIT)).toBe(true);
    expect(SESSION_SPEND_LIST_LIMIT).toBe(200);
  });

  test('a partial window reads as recent sessions', () => {
    expect(spendWindowCopy(0)).toBe('Last 7 days · recent sessions');
    expect(spendWindowCopy(3)).toBe('Last 7 days · recent sessions');
    expect(spendWindowCopy(SESSION_SPEND_LIST_LIMIT - 1)).toBe('Last 7 days · recent sessions');
  });

  test('a filled window names its bound', () => {
    expect(spendWindowCopy(SESSION_SPEND_LIST_LIMIT)).toBe(
      `Last 7 days · newest ${SESSION_SPEND_LIST_LIMIT} sessions`,
    );
    expect(spendWindowCopy(SESSION_SPEND_LIST_LIMIT + 50)).toContain(
      `newest ${SESSION_SPEND_LIST_LIMIT} sessions`,
    );
  });

  test('an unreadable count never claims the bound', () => {
    expect(spendWindowCopy(Number.NaN)).toBe('Last 7 days · recent sessions');
    expect(spendWindowCopy(-1)).toBe('Last 7 days · recent sessions');
  });
});

describe('/usage spend window', () => {
  const contextFor = (gatewayRequest: jest.Mock) => ({
    hello: null,
    gatewayRequest,
    runAgentCommand: jest.fn(),
  });

  const row = (id: number) => ({ id: `s${id}`, input_tokens: 1, output_tokens: 1 });

  test('reads the catalogue-wide window', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ object: 'list', data: [row(1), row(2)] });
    const result = await executeGatewaySlashCommand('/usage', contextFor(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT });
    expect(result.text).toBe('Sessions: 2\nTokens: 4\nCost: —');
  });

  test('a filled window names its bound', async () => {
    const data = Array.from({ length: SESSION_SPEND_LIST_LIMIT }, (_, index) => row(index));
    const gatewayRequest = jest.fn().mockResolvedValue({ object: 'list', data });
    const result = await executeGatewaySlashCommand('/usage', contextFor(gatewayRequest));
    expect(result.text).toBe(
      `Sessions: ${SESSION_SPEND_LIST_LIMIT}\nTokens: 400\nCost: —\nNewest ${SESSION_SPEND_LIST_LIMIT} sessions.`,
    );
  });

  test('a filled window that dropped a row it could not parse still names its bound', async () => {
    const data = Array.from({ length: SESSION_SPEND_LIST_LIMIT }, (_, index) =>
      index === SESSION_SPEND_LIST_LIMIT - 1 ? null : row(index),
    );
    const gatewayRequest = jest.fn().mockResolvedValue({ object: 'list', data });
    const result = await executeGatewaySlashCommand('/usage', contextFor(gatewayRequest));
    expect(result.text).toBe(
      `Sessions: ${SESSION_SPEND_LIST_LIMIT - 1}\nTokens: ${(SESSION_SPEND_LIST_LIMIT - 1) * 2}\nCost: —\nNewest ${SESSION_SPEND_LIST_LIMIT} sessions.`,
    );
  });

  test('a partial window that dropped a row reads as recent sessions, no bound', async () => {
    const gatewayRequest = jest
      .fn()
      .mockResolvedValue({ object: 'list', data: [row(1), null, row(2)] });
    const result = await executeGatewaySlashCommand('/usage', contextFor(gatewayRequest));
    expect(result.text).toBe('Sessions: 2\nTokens: 4\nCost: —');
  });

  test('a failed read keeps the failure copy, never zeros', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeGatewaySlashCommand('/usage', contextFor(gatewayRequest));
    expect(result.text).toBe('Sessions could not be read.');
  });
});

describe('the sparkline caption names the read, not the rows that parsed', () => {
  const analytics = () => readSource('src', 'components', 'chat', 'session-analytics.tsx');
  const sheet = () => readSource('src', 'components', 'chat', 'chat-overflow-sheet.tsx');
  const chatScreen = () => readSource('src', 'components', 'chat', 'chat-screen.tsx');

  test('SessionAnalytics captions the sparkline from its rowCount prop', () => {
    const src = analytics();
    expect(src).toContain('rowCount: number;');
    expect(src).toContain('spendWindowCopy(rowCount)');
    expect(src).not.toContain('spendWindowCopy(sessions.length)');
  });

  test('the overflow sheet threads the row count down to the sparkline', () => {
    const src = sheet();
    expect(src).toContain('rowCount: number;');
    const block = src.match(/<SessionAnalytics[\s\S]*?\/>/)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('rowCount={rowCount}');
  });

  test('the chat screen feeds the provider-shaped spend state row count', () => {
    const src = chatScreen();
    const block = src.match(/<ChatOverflowSheet[\s\S]*?\/>/)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('rowCount={');
    expect(block).toContain('spendState.rowCount');
  });

  test('the sparkline data still comes from the parsed rows it always did', () => {
    const src = analytics();
    expect(src).toContain('weekBuckets(sessions, now)');
    expect(src).toContain('relativeMeter');
  });
});
