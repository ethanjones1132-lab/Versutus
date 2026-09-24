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

// The card rendered the badge + approvalAuditSummaryCopy(audit.length)
// unconditionally, so first paint asserted "No approval decisions recorded
// on this device yet." before the deferred lenient read landed — the exact
// lie Activity's card closed with auditState (iter-322), while this second
// door kept the lenient contract. Fix is render-side: a loaded gate.
describe('gateway settings decision-history loading honesty', () => {
  test('the screen tracks the audit read with a loaded gate', () => {
    const src = readSettings();
    expect(src).toMatch(/const \[auditLoaded, setAuditLoaded\] = useState\(false\)/);
  });

  test('the mount read still goes through the lenient loader and settles the gate', () => {
    const src = readSettings();
    const effectAt = src.indexOf('void loadApprovalAudit().then(');
    expect(effectAt).toBeGreaterThanOrEqual(0);
    const body = src.slice(effectAt, effectAt + 240);
    expect(body).toContain('setAudit(entries)');
    expect(body).toContain('setAuditLoaded(true)');
    // Render-side scope: this door keeps the lenient contract.
    expect(src).not.toContain('loadApprovalAuditStrict');
  });

  test('while the read is in flight the card shows a Skeleton, never the empty claim', () => {
    const card = readAuditCard();
    const loadingAt = card.indexOf('{!auditLoaded ? (');
    const skeletonAt = card.indexOf('<Skeleton');
    expect(loadingAt).toBeGreaterThanOrEqual(0);
    expect(skeletonAt).toBeGreaterThan(loadingAt);
    // The summary copy lives only in the settled branch, after the ternary.
    const elseAt = card.indexOf(') : (', loadingAt);
    expect(elseAt).toBeGreaterThan(loadingAt);
    const summaryAt = card.indexOf('approvalAuditSummaryCopy');
    expect(summaryAt).toBeGreaterThan(elseAt);
  });

  test('the badge count and the recent rows wait for the settled read', () => {
    const card = readAuditCard();
    const settledAt = card.indexOf('{auditLoaded ? (');
    const badgeAt = card.indexOf('label={String(audit.length)}');
    const rowsAt = card.indexOf('audit.slice(0, 5).map(');
    expect(settledAt).toBeGreaterThanOrEqual(0);
    expect(badgeAt).toBeGreaterThan(settledAt);
    expect(rowsAt).toBeGreaterThan(badgeAt);
  });

  test('keep working: summary copy, five-row slice, and the loader contract are intact', () => {
    const src = readSettings();
    expect(src).toContain('approvalAuditSummaryCopy(audit.length)');
    expect(src).toContain('audit.slice(0, 5).map(');
    expect(src).toContain('loadApprovalAudit');
    expect(src).toContain('approvalAuditCopy');
  });
});
