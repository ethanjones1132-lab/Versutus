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

/** The Approval-decisions card, from its heading to the next sibling card. */
function readAuditCard(): string {
  const src = readActivity();
  const start = src.indexOf('<Text variant="headline">Approval decisions</Text>');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('<ApprovalDecisionCard', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// loadApprovalAudit folds a storage refusal into [] (approval-policy.ts),
// so the Activity tab's `.catch(() => undefined)` was dead: in-flight, failed,
// and genuinely-empty all rendered the same "No approval decisions recorded"
// tally. The tab needs its own state machine over a loader that can refuse.
describe('activity approval-decisions card honesty', () => {
  test('the tab tracks the audit read as loading, ready, or failed', () => {
    const src = readActivity();
    expect(src).toMatch(
      /useState<'loading' \| 'ready' \| 'failed'>\('loading'\)/,
    );
  });

  test('the mount read goes through the strict loader and records a refusal', () => {
    const src = readActivity();
    expect(src).toContain('loadApprovalAuditStrict');
    expect(src).toMatch(/setAuditState\('failed'\)/);
    expect(src).toMatch(/setAuditState\('ready'\)/);
    // The lenient loader (which hides failures) no longer feeds the card.
    expect(src).not.toMatch(/loadApprovalAudit\(\)\.then\(/);
  });

  test('while the read is in flight the card shows a Skeleton, never the tally copy', () => {
    const card = readAuditCard();
    const loadingAt = card.indexOf("auditState === 'loading'");
    const skeletonAt = card.indexOf('<Skeleton');
    const tallyAt = card.indexOf('approvalAuditTallyCopy');
    expect(loadingAt).toBeGreaterThanOrEqual(0);
    expect(skeletonAt).toBeGreaterThan(loadingAt);
    // The tally is not reachable from the loading branch: it sits in the
    // ready branch, after the loading guard.
    const readyAt = card.indexOf("auditState === 'ready'");
    expect(readyAt).toBeGreaterThan(loadingAt);
    expect(tallyAt).toBeGreaterThan(readyAt);
  });

  test('a failed read renders an inline ErrorCard with a retry, not the empty tally', () => {
    const card = readAuditCard();
    const failedAt = card.indexOf("auditState === 'failed'");
    const errorCardAt = card.indexOf('<ErrorCard');
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(errorCardAt).toBeGreaterThan(failedAt);
    expect(card).toMatch(/onRetry=\{[\s\S]*readAudit/);
    // The genuinely-empty copy is the ready branch's answer only.
    const tallyAt = card.indexOf('approvalAuditTallyCopy');
    expect(tallyAt).toBeGreaterThan(failedAt);
  });

  test('the ready branch keeps the tally and the four-line recent list', () => {
    const card = readAuditCard();
    expect(card).toContain('approvalAuditTallyCopy(audit)');
    expect(card).toMatch(/approvalAuditRecent\(audit, 4\)/);
  });

  test('pull-to-refresh re-reads the audit through the same state machine', () => {
    const src = readActivity();
    const refreshAt = src.indexOf('const onRefresh');
    expect(refreshAt).toBeGreaterThanOrEqual(0);
    const body = src.slice(refreshAt, src.indexOf('\n  };', refreshAt));
    expect(body).toMatch(/readAudit/);
    expect(body).not.toContain('loadApprovalAudit');
  });
});
