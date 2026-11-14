declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSettings(): string {
  return readSource(['src', 'app', 'gateway', 'settings.tsx']);
}

/** The Decision history card, from its headline to the next sibling card. */
function readAuditCard(): string {
  const src = readSettings();
  const start = src.indexOf('<Text variant="headline">Decision history</Text>');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('{activeGateway ? (', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// This is the sole history surface. A failed storage read must remain distinct
// from a real empty log, with a retry at the same surface.
describe('gateway settings decision-history read honesty', () => {
  test('the screen tracks loading, ready, and failed audit states', () => {
    const src = readSettings();
    expect(src).toMatch(/const \[auditState, setAuditState\] = useState<'loading' \| 'ready' \| 'failed'>\('loading'\)/);
    expect(src).toMatch(/const \[auditError, setAuditError\] = useState<string \| null>\(null\)/);
  });

  test('the read uses the strict loader and preserves a failure cause for Retry', () => {
    const src = readSettings();
    expect(src).toContain('loadApprovalAuditStrict');
    expect(src).not.toContain('loadApprovalAudit,');
    const reader = src.match(/const runAuditRead = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0];
    expect(reader).toBeDefined();
    expect(reader).toContain('setAudit(entries)');
    expect(reader).toContain("setAuditState('ready')");
    expect(reader).toContain('setAuditError(failureMessage(caught))');
    expect(reader).toContain("setAuditState('failed')");
    expect(src).toMatch(/const retryAuditRead = useCallback\(\(\) => \{\s*setAuditState\('loading'\);\s*runAuditRead\(\);/);
  });

  test('the mount read is cancelled on unmount and starts in the loading state', () => {
    const src = readSettings();
    expect(src).toContain('runAuditRead();');
    expect(src).toContain('auditMountedRef.current = false;');
    expect(src).toContain('auditRequestRef.current += 1;');
  });

  test('while the read is in flight the card shows a Skeleton and no count', () => {
    const card = readAuditCard();
    const loadingAt = card.indexOf("auditState === 'loading'");
    const skeletonAt = card.indexOf('<Skeleton');
    const summaryBranchAt = card.lastIndexOf("auditState === 'ready'");
    const summaryAt = card.indexOf('approvalAuditSummaryCopy(audit.length)');
    expect(loadingAt).toBeGreaterThanOrEqual(0);
    expect(skeletonAt).toBeGreaterThan(loadingAt);
    expect(summaryBranchAt).toBeGreaterThan(skeletonAt);
    expect(summaryAt).toBeGreaterThan(summaryBranchAt);
    expect(card).toMatch(/\{auditState === 'ready' \? \([\s\S]*?<Badge[\s\S]*?label=\{String\(audit.length\)\}/);
  });

  test('a failed read renders a meaningful ErrorCard with a retry, not an empty count', () => {
    const card = readAuditCard();
    const failedAt = card.indexOf("auditState === 'failed'");
    const errorAt = card.indexOf('<ErrorCard');
    expect(errorAt).toBeGreaterThan(failedAt);
    expect(card).toContain('cause={auditError ??');
    expect(card).toContain('affected="approval decisions saved on this device"');
    expect(card).toContain('next="Retry the read."');
    expect(card).toContain('onRetry={retryAuditRead}');
    expect(card.indexOf('approvalAuditSummaryCopy(audit.length)')).toBeGreaterThan(
      card.indexOf("auditState === 'ready'"),
    );
  });

  test('only a successful read renders the count, summary, and recent rows', () => {
    const card = readAuditCard();
    const readyAt = card.indexOf("auditState === 'ready'");
    const badgeAt = card.indexOf('label={String(audit.length)}');
    const summaryAt = card.indexOf('approvalAuditSummaryCopy(audit.length)');
    const rowsAt = card.indexOf('audit.slice(0, 5).map(');
    expect(readyAt).toBeGreaterThanOrEqual(0);
    expect(badgeAt).toBeGreaterThan(readyAt);
    expect(summaryAt).toBeGreaterThan(readyAt);
    expect(rowsAt).toBeGreaterThan(badgeAt);
  });

  test('keep working: summary copy, five-row slice, and the loader contract are intact', () => {
    const src = readSettings();
    expect(src).toContain('approvalAuditSummaryCopy(audit.length)');
    expect(src).toContain('audit.slice(0, 5).map(');
    expect(src).toContain('loadApprovalAuditStrict');
    expect(src).toContain('approvalAuditCopy');
  });
});
