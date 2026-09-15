// The audit an approval writes should name what was decided, not just who and
// which class. These tests pin the context the provider carries into
// `recordApprovalDecision` — the operator site reads it off the matching
// pending row, the policy site reads it off the run prompt.

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

describe('the approval audit carries decision context', () => {
  it('the operator site records the context from the matched pending row', () => {
    const provider = readSource(['src', 'context', 'gateway-provider.tsx']);
    const operatorSite = provider.slice(
      provider.indexOf("decision === 'approve' ? 'approval.approve' : 'approval.deny'"),
      provider.indexOf("await refreshPendingApprovals();"),
    );
    expect(operatorSite).toContain("source: 'operator'");
    expect(operatorSite).toMatch(/\boperation:\s*row/);
    expect(operatorSite).toMatch(/\bsummary:\s*row/);
    expect(operatorSite).toMatch(/\bbotId:\s*row/);
  });

  it('the policy site records the operation from the run prompt', () => {
    const provider = readSource(['src', 'context', 'gateway-provider.tsx']);
    const policySite = provider.slice(
      provider.indexOf("void recordApprovalDecision({"),
      provider.indexOf("return { approved: true };"),
    );
    expect(policySite).toContain("source: 'policy'");
    expect(policySite).toMatch(/\boperation:\s*prompt\.slice/);
  });

  it('a pending row parses an optional botId alongside its class', () => {
    const row = readSource(['src', 'lib', 'gateway', 'approvals.ts']);
    expect(row).toContain('botId?: string;');
    expect(row).toMatch(/botId:\s*text\(record\./);
  });

  it('an audit entry without context still records (older callers unaffected)', () => {
    const source = readSource(['src', 'lib', 'gateway', 'approval-policy.ts']);
    expect(source).toContain('operation?: string;');
    expect(source).not.toMatch(/operation:\s*string;/);
  });
});
