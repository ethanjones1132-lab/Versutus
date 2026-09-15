import {
  APPROVAL_AUDIT_CAP,
  appendApprovalAudit,
  approvalAuditCopy,
  approvalAuditFromUnknown,
  approvalAuditSummaryCopy,
  approvalPoliciesFromUnknown,
  approvalPolicyCopy,
  approvalPolicyDecision,
  approvalPolicyKey,
  normalizeApprovalClass,
  setApprovalPolicy,
  type ApprovalAuditEntry,
} from '@/lib/gateway/approval-policy';
import {
  approvalAuditTallyCopy,
  approvalAuditRecent,
} from '@/lib/gateway/approval-audit-view';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

describe('normalizeApprovalClass', () => {
  it('keeps the Gate classes it knows', () => {
    expect(normalizeApprovalClass('destructive')).toBe('destructive');
    expect(normalizeApprovalClass('workspace_write')).toBe('workspace_write');
  });

  it('folds casing, spaces and hyphens, and a couple of aliases', () => {
    expect(normalizeApprovalClass('READ-ONLY')).toBe('read');
    expect(normalizeApprovalClass('Workspace Write')).toBe('workspace_write');
  });

  it('fails closed to unknown for anything it cannot classify', () => {
    expect(normalizeApprovalClass('shell')).toBe('unknown');
    expect(normalizeApprovalClass(undefined)).toBe('unknown');
    expect(normalizeApprovalClass(42)).toBe('unknown');
  });
});

describe('approvalPolicyDecision', () => {
  const gatewayId = 'gw';
  const botId = 'scout';

  it('asks when the Bot has no policy', () => {
    const verdict = approvalPolicyDecision({ policies: {}, gatewayId, botId, cls: 'read' });
    expect(verdict.decision).toBe('ask');
  });

  it('auto-approves read-only only for an opted-in Bot', () => {
    const policies = setApprovalPolicy({}, gatewayId, botId, true);
    expect(approvalPolicyDecision({ policies, gatewayId, botId, cls: 'read' }).decision).toBe('approve');
    expect(approvalPolicyDecision({ policies, gatewayId, botId: 'other', cls: 'read' }).decision).toBe('ask');
  });

  it('names what the opt-in does, and what it never covers', () => {
    expect(approvalPolicyCopy(true)).toMatch(/Read-only/);
    expect(approvalPolicyCopy(false)).toMatch(/asks before every command/);
  });

  it('never auto-approves a destructive class, even when opted in', () => {
    const policies = setApprovalPolicy({}, gatewayId, botId, true);
    for (const cls of ['destructive', 'credential', 'bypass', 'unknown'] as const) {
      const verdict = approvalPolicyDecision({ policies, gatewayId, botId, cls });
      expect(verdict.decision).toBe('ask');
      expect(verdict.reason).toMatch(/never|confirm/i);
    }
  });
});

describe('policy storage shape', () => {
  it('round-trips through unknown, dropping junk', () => {
    const policies = setApprovalPolicy({}, 'gw', 'scout', true);
    const parsed = approvalPoliciesFromUnknown(JSON.parse(JSON.stringify(policies)));
    expect(parsed).toEqual(policies);
    expect(approvalPoliciesFromUnknown({ junk: { autoApproveRead: 'yes' } })).toEqual({});
    expect(approvalPoliciesFromUnknown('nope')).toEqual({});
  });

  it('clears the policy when the opt-in is turned off', () => {
    const on = setApprovalPolicy({}, 'gw', 'scout', true);
    expect(setApprovalPolicy(on, 'gw', 'scout', false)).toEqual({});
  });

  it('keys a Bot without colliding on separators', () => {
    expect(approvalPolicyKey('gw', 'a/b')).toBe(approvalPolicyKey('gw', 'a\\b'));
  });
});

describe('audit log', () => {
  const entry = (id: string, at: number): ApprovalAuditEntry => ({
    approvalId: id,
    cls: 'read',
    decision: 'approve',
    source: 'policy',
    at,
  });

  it('keeps newest first and caps the log', () => {
    let log: ApprovalAuditEntry[] = [];
    for (let i = 0; i < APPROVAL_AUDIT_CAP + 5; i += 1) log = appendApprovalAudit(log, entry(`a${i}`, i));
    expect(log.length).toBe(APPROVAL_AUDIT_CAP);
    expect(log[0].approvalId).toBe(`a${APPROVAL_AUDIT_CAP + 4}`);
  });

  it('reads junk as an empty log', () => {
    expect(approvalAuditFromUnknown(null)).toEqual([]);
    expect(approvalAuditFromUnknown([{ nope: true }, entry('ok', 1)])).toEqual([entry('ok', 1)]);
  });

  it('names who decided, what class, and the source', () => {
    expect(approvalAuditCopy(entry('a', 1))).toBe('Auto-approved · read · policy');
    expect(
      approvalAuditCopy({ approvalId: 'b', cls: 'destructive', decision: 'deny', source: 'operator', at: 2 }),
    ).toBe('Denied · destructive · operator');
  });

  it('appends the operation or summary to the line when one is present', () => {
    expect(approvalAuditCopy({ ...entry('a', 1), operation: 'ls -la' })).toBe(
      'Auto-approved · read · policy · ls -la',
    );
    expect(
      approvalAuditCopy({ ...entry('b', 2), decision: 'deny', source: 'operator', summary: 'rm -rf /tmp/x' }),
    ).toBe('Denied · read · operator · rm -rf /tmp/x');
    expect(approvalAuditCopy({ ...entry('c', 3), operation: '  ', summary: '  ' })).toBe(
      'Auto-approved · read · policy',
    );
  });

  it('keeps accepting and copying entries without context', () => {
    expect(approvalAuditFromUnknown([{ nope: 1 }, entry('ok', 1)])).toEqual([entry('ok', 1)]);
  });

  it('summarizes an empty or live history honestly', () => {
    expect(approvalAuditSummaryCopy(0)).toMatch(/No approval decisions/);
    expect(approvalAuditSummaryCopy(1)).toBe('1 decision recorded on this device.');
    expect(approvalAuditSummaryCopy(3)).toBe('3 decisions recorded on this device.');
  });
});

describe('audit activity view', () => {
  const approve = (approvalId: string, at: number): ApprovalAuditEntry => ({
    approvalId,
    cls: 'read',
    decision: 'approve',
    source: 'operator',
    at,
  });
  const deny = (approvalId: string, at: number): ApprovalAuditEntry => ({
    approvalId,
    cls: 'destructive',
    decision: 'deny',
    source: 'operator',
    at,
  });

  it('counts approved and denied decisions', () => {
    expect(approvalAuditTallyCopy([])).toMatch(/no approval decisions/i);
    const log = [approve('a', 1), deny('b', 2), approve('c', 3)];
    const copy = approvalAuditTallyCopy(log);
    expect(copy).toMatch(/2 approved/);
    expect(copy).toMatch(/1 denied/);
  });

  it('takes the newest decisions, newest first', () => {
    const log = [approve('a', 1), deny('b', 2), approve('c', 3), deny('d', 4), approve('e', 5)];
    expect(approvalAuditRecent(log, 3).map((record) => record.approvalId)).toEqual(['e', 'd', 'c']);
  });
});
