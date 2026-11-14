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

function readSettings(): string {
  return readSource(['src', 'app', 'gateway', 'settings.tsx']);
}

/** The decision-history card and its bounded recent rows. */
function readAuditCard(): string {
  const src = readSettings();
  const start = src.indexOf('<Text variant="headline">Decision history</Text>');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('{activeGateway ? (', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// Decision history lives in Gateway Settings, not Activity's Today feed.
// Settings keeps a loaded gate so its empty copy waits for the storage read.
describe('approval decision history ownership', () => {
  test('Activity stays focused on Today and Routines', () => {
    const src = readSource(['src', 'app', '(tabs)', 'activity.tsx']);
    expect(src).toContain('<TodaySection');
    expect(src).toContain('<RoutinesSection');
    expect(src).not.toContain('Your decisions');
    expect(src).not.toContain('loadApprovalAudit');
  });

  test('Gateway Settings keeps storage failure separate from a genuinely empty history', () => {
    const src = readSettings();
    expect(src).toContain('loadApprovalAuditStrict');
    expect(src).toMatch(/auditState === 'failed'/);
    expect(src).toContain('affected="approval decisions saved on this device"');
    expect(src).toContain('onRetry={retryAuditRead}');
    expect(src).not.toContain('loadApprovalAudit,');
  });

  test('only the ready Settings branch renders the summary and five recent rows', () => {
    const card = readAuditCard();
    expect(card).toContain("auditState === 'ready'");
    expect(card).toContain('approvalAuditSummaryCopy(audit.length)');
    expect(card).toContain('audit.slice(0, 5).map(');
  });
});
