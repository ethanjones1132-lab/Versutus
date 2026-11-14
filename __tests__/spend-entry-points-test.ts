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

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const entryRow = () => readSource('src', 'components', 'gateway', 'spend-entry-row.tsx');
const settingsScreen = () => readSource('src', 'app', 'gateway', 'settings.tsx');
const activityScreen = () => readSource('src', 'app', '(tabs)', 'activity.tsx');
const spendScreen = () => readSource('src', 'app', 'gateway', 'spend.tsx');

// Spend remains reachable from gateway settings, where its connection-gated
// destination has meaningful gateway context.
describe('the Spend screen opens from gateway settings', () => {
  test('gateway settings carries one way in', () => {
    const src = settingsScreen();
    expect(src).toContain("from '@/components/gateway/spend-entry-row'");
    expect(countOccurrences(src, '<SpendEntryRow />')).toBe(1);
  });

  test('Activity keeps Today and Routines and leaves the spend entry in settings', () => {
    const src = activityScreen();
    expect(src).toContain('<TodaySection');
    expect(src).toContain('<RoutinesSection');
    expect(src).not.toContain('<SpendEntryRow');
    expect(settingsScreen()).toContain('<SpendEntryRow />');
  });

  test('the row itself targets the Spend route, which is what makes both links that route', () => {
    expect(entryRow()).toContain('<Link href="/gateway/spend" asChild>');
  });
});

describe('the row is offered only while the connection can answer', () => {
  test('the connection decides before the link is built', () => {
    const src = entryRow();
    const gate = src.indexOf("if (status !== 'connected') return null;");
    const link = src.indexOf('<Link href="/gateway/spend" asChild>');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThan(gate);
  });

  test('it decides from the same status the Spend route reads on', () => {
    expect(entryRow()).toContain('const { status } = useGateway();');
    expect(spendScreen()).toContain("if (status !== 'connected') return;");
  });

  test('it computes no spend of its own', () => {
    const src = entryRow();
    expect(src).not.toContain('gatewayRequest');
    expect(src).not.toContain('sessionSpendCopy');
    expect(src).not.toContain('totalUsage');
  });
});

describe('what must keep working', () => {
  test("gateway settings keeps its Gate setup and runtime-environment links", () => {
    const src = settingsScreen();
    expect(src).toContain('<Link href="/gateway/setup" asChild>');
    expect(src).toContain('<Link href="/gateway/diagnostics" asChild>');
  });

  test('Activity keeps its Today and Routines destinations without legacy sections', () => {
    const src = activityScreen();
    expect(src).toContain('<TodaySection');
    expect(src).toContain('<RoutinesSection');
    expect(src).not.toContain('<CronSection');
    expect(src).not.toContain('<AgentTargets');
  });

  test('the Spend route keeps its own read and its own gate', () => {
    const src = spendScreen();
    expect(src).toContain("gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT })");
    expect(src).toContain("if (status !== 'connected') return;");
  });
});
