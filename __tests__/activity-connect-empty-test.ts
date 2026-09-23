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

function readActivity(): string {
  return readSource(['src', 'app', '(tabs)', 'activity.tsx']);
}

function readRuns(): string {
  return readSource(['src', 'app', 'runs.tsx']);
}

function readEmptyState(): string {
  const src = readRuns();
  const match = src.match(/<EmptyState[\s\S]*?\/>/);
  expect(match).not.toBeNull();
  return match![0];
}

// The Runs empty state titles "Connect to start runs" and describes
// reconnect when a gateway profile is selected but the connection is not
// live, yet it passed neither actionLabel nor onAction. EmptyState already
// renders a button when both are set, and connectGateway is already in
// scope (AgentTargets uses it). Offer Reconnect on that variant only.
describe('runs connect-to-start-runs empty state', () => {
  test('the Connect-to-start-runs empty state offers Reconnect wired to connectGateway', () => {
    const empty = readEmptyState();
    expect(empty).toContain("'Connect to start runs'");
    expect(empty).toMatch(/actionLabel=\{[\s\S]*'Reconnect'/);
    expect(empty).toMatch(/onAction=\{[\s\S]*void connectGateway\(activeGateway\)/);
  });

  test('Reconnect is offered only when a gateway profile is selected and not connected', () => {
    const empty = readEmptyState();
    expect(empty).toMatch(
      /actionLabel=\{activeGateway && status !== 'connected' \? 'Reconnect' : undefined\}/,
    );
    expect(empty).toMatch(
      /onAction=\{\s*activeGateway && status !== 'connected'\s*\?[\s\S]*void connectGateway\(activeGateway\)[\s\S]*: undefined\s*\}/,
    );
  });

  test('the Nothing-to-watch title and description stay byte-identical, with no action of their own', () => {
    const empty = readEmptyState();
    expect(empty).toContain("'Nothing to watch yet'");
    expect(empty).toContain(
      "'Connect to a gateway that supports agentic runs, then start one here or with /run in chat.'",
    );
    expect(empty).not.toMatch(/Nothing to watch yet[\s\S]*actionLabel="[^"]+"/);
  });

  test('the Runs-not-offered title and description stay byte-identical, with no action of their own', () => {
    const empty = readEmptyState();
    expect(empty).toContain("'Runs not offered'");
    expect(empty).toContain(
      '${activeGateway.name} is chat-only (or has no run API). Chat still works; agentic runs need Hermes /v1/runs.',
    );
    expect(empty).not.toMatch(/Runs not offered[\s\S]*actionLabel="[^"]+"/);
  });

  test('the No-runs-yet title and description stay byte-identical, with no action of their own', () => {
    const empty = readEmptyState();
    expect(empty).toContain("'No runs yet'");
    expect(empty).toContain(
      "'Start a run above, use Chat overflow → Run task, or type /run <prompt> in chat.'",
    );
    expect(empty).not.toMatch(/No runs yet[\s\S]*actionLabel="[^"]+"/);
  });

  test('AgentTargets still connects the tapped gateway profile independently', () => {
    const src = readActivity();
    expect(src).toContain('<AgentTargets');
    expect(src).toMatch(/onSelect=\{\(gateway\) => \{\s*void connectGateway\(gateway\);/);
  });
});

// With zero runs the FlatList body contributes no rows, so the footer is the
// whole screen below the Start-a-run card. The zero-runs EmptyState is that
// screen's primary message and must lead the footer — the Scorecards card
// (weekly opt-in, empty window copy) follows it, never buries it.
describe('runs footer places the zero-runs EmptyState first', () => {
  test('the EmptyState renders above ScorecardsSection inside listFooter', () => {
    const src = readRuns();
    const footerAt = src.indexOf('const listFooter = (');
    const emptyAt = src.indexOf('<EmptyState');
    const scorecardsAt = src.indexOf('<ScorecardsSection');

    expect(footerAt).toBeGreaterThanOrEqual(0);
    expect(emptyAt).toBeGreaterThan(footerAt);
    expect(scorecardsAt).toBeGreaterThan(footerAt);
    expect(emptyAt).toBeLessThan(scorecardsAt);
  });

  test('ScorecardsSection still renders in the footer so the weekly opt-in stays reachable', () => {
    const src = readRuns();
    expect(src).toMatch(
      /const listFooter = \([\s\S]*<ScorecardsSection runs=\{activityRunsForActiveGateway\}/,
    );
  });
});
