import { COUNCIL_ROOM_PREFIX, councilDisabledCopy, councilRoomName } from '@/lib/gateway/council';

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

const councilRoute = () => readSource('src', 'app', 'council.tsx');
const compareView = () => readSource('src', 'components', 'chat', 'council-compare-view.tsx');

describe('the council room name is short and named', () => {
  test('it names the prompt, and falls back when the prompt is blank', () => {
    expect(councilRoomName('Compare notes.')).toBe('Council · Compare notes.');
    expect(councilRoomName('   ')).toBe(`${COUNCIL_ROOM_PREFIX}comparison`);
  });

  test('a long prompt is capped so the transient room name stays a label', () => {
    const name = councilRoomName('x'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name.startsWith(COUNCIL_ROOM_PREFIX)).toBe(true);
  });
});

describe('a gateway that cannot hold rooms says so', () => {
  test('the disabled copy names the missing capability, not a generic failure', () => {
    expect(councilDisabledCopy()).toContain('group rooms');
    expect(councilDisabledCopy()).not.toMatch(/error|failed/i);
  });
});

// D7's view: the columns are the shipped council result, and the send rides the
// existing group round — one request the Gate fans out per Bot — with
// `runCouncil` still enforcing order and per-Bot failure isolation. The room is
// transient and deleted in a finally.
describe('the council view draws the shipped columns', () => {
  test('the view renders one column per target and summarizes the round', () => {
    const src = compareView();
    expect(src).toContain('CouncilColumn');
    expect(src).toContain('councilSummaryCopy(columns)');
    expect(src).toContain('<ScrollView');
    expect(src).toContain('onPressColumn');
    expect(src).not.toContain('gatewayRequest(');
  });

  test('a failed column names its own error rather than hiding behind the summary', () => {
    const src = compareView();
    expect(src).toContain("column.state === 'failed'");
    expect(src).toContain('column.error');
    expect(src).toContain('column.text');
  });

  test("a quiet 'nothing to add' column is muted copy, never an error slot", () => {
    const src = compareView();
    expect(src).toContain("column.state === 'silent'");
    expect(src).toContain('Nothing to add');
    expect(src).toContain('had nothing to add');
  });
});

describe('the council route sends through the existing group round', () => {
  test('it selects roster Bots, creates one transient room, and deletes it', () => {
    const src = councilRoute();
    expect(src).toContain('councilTargets(');
    expect(src).toContain('botGroups.create(');
    expect(src).toContain('botGroups.send(');
    expect(src).toContain('botGroups.deleteGroup(');
    expect(src).toContain('councilRoomName(');
    expect(src).toContain('finally');
  });

  test('runCouncil is the isolation layer over the round it already fetched', () => {
    const src = councilRoute();
    expect(src).toContain('runCouncil(');
    expect(src).toContain('<CouncilCompareView');
    expect(src).toContain('hasGroupRooms');
    expect(src).not.toContain('gatewayRequest(');
  });

  test('a slash-leading prompt is refused before the group round is sent', () => {
    const src = councilRoute();
    expect(src).toContain('councilPromptIssue(');
    expect(src).toContain('round.errors');
  });
});

describe('the council is a Stack destination with one entry on Home', () => {
  const rootLayout = () => readSource('src', 'app', '_layout.tsx');
  const homeDashboard = () =>
    readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');

  test('the Stack registers a full-screen (not modal) council route', () => {
    const src = rootLayout();
    expect(src).toContain('name="council"');
    const council = src.slice(src.indexOf('name="council"'));
    expect(council.slice(0, council.indexOf('/>'))).not.toContain("presentation: 'modal'");
  });

  test("Home's connection hero carries the council entry", () => {
    expect(homeDashboard()).toContain("router.push('/council')");
  });
});

/** The roster/prompt card, from its count heading to the prompt field. */
function pickerCard(): string {
  const src = councilRoute();
  const start = src.indexOf('Bots to compare');
  const end = src.indexOf('<TextField', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// The roster read starts [] and its catch folded a refusal back into [], so
// loading, failed, and genuinely-empty all rendered the same dead chip box —
// and the compare round's failure was a faint tertiary caption where every
// other surface names it with an ErrorCard.
describe('the council roster tells loading, failed, and empty apart', () => {
  test('the roster read is tracked as loading, ready, or failed', () => {
    const src = councilRoute();
    expect(src).toMatch(/useState<'loading' \| 'ready' \| 'failed'>/);
    expect(src).toMatch(/setRosterState\('failed'\)/);
    expect(src).toMatch(/setRosterState\('ready'\)/);
    // A refusal no longer answers by silently claiming an empty roster.
    expect(src).not.toMatch(/catch\(\(\) => \{\s*if \(!cancelled\) setRoster\(\[\]\)/);
  });

  test('while the roster read is in flight the chips slot shows skeletons, not an empty chip row', () => {
    const card = pickerCard();
    const loadingAt = card.indexOf("rosterState === 'loading'");
    expect(loadingAt).toBeGreaterThanOrEqual(0);
    const skeletonAt = card.indexOf('<Skeleton', loadingAt);
    expect(skeletonAt).toBeGreaterThan(loadingAt);
    const chipsAt = card.indexOf('roster.map', skeletonAt);
    // The chip map sits behind the ready guard, never reachable while in flight.
    const readyAt = card.indexOf("rosterState === 'ready'");
    if (chipsAt >= 0) {
      expect(readyAt).toBeGreaterThanOrEqual(0);
      expect(chipsAt).toBeGreaterThan(readyAt);
    }
  });

  test('a failed roster read is an ErrorCard with a retry, not a dead chip box', () => {
    const card = pickerCard();
    const failedAt = card.indexOf("rosterState === 'failed'");
    expect(failedAt).toBeGreaterThanOrEqual(0);
    const errorCardAt = card.indexOf('<ErrorCard', failedAt);
    expect(errorCardAt).toBeGreaterThan(failedAt);
    expect(card).toMatch(/onRetry=\{[\s\S]*loadRoster/);
    // The empty-roster claim is gated behind a completed, successful read.
    const emptyAt = card.indexOf('<EmptyState');
    if (emptyAt >= 0) expect(emptyAt).toBeGreaterThan(failedAt);
  });

  test('a genuinely empty ready roster is an EmptyState naming the missing Bots', () => {
    const card = pickerCard();
    const readyAt = card.indexOf("rosterState === 'ready'");
    expect(readyAt).toBeGreaterThanOrEqual(0);
    const emptyAt = card.indexOf('<EmptyState', readyAt);
    expect(emptyAt).toBeGreaterThan(readyAt);
    expect(card.slice(emptyAt, emptyAt + 400)).toMatch(/No bots on this gateway/i);
  });

  test('a failed compare round surfaces as an ErrorCard, never a faint caption', () => {
    const src = councilRoute();
    expect(src).toContain('<ErrorCard');
    expect(src).not.toMatch(/color="tertiary">\s*\{\s*error \?\? promptIssue/);
    expect(src).not.toMatch(/error \?\? promptIssue\s*\}/);
  });
});
