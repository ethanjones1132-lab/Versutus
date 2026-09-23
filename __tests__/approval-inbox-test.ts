import {
  approvalClassLabel,
  approvalInboxCopy,
  approvalRowsFromUnknown,
  batchApprovableRows,
} from '@/lib/gateway/approvals';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

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

describe('approvalRowsFromUnknown', () => {
  it('reads the Gate approvals.pending shape with its class and summary', () => {
    const rows = approvalRowsFromUnknown({
      approvals: [
        {
          approvalId: 'a1',
          type: 'workspace_write',
          runId: 'run-1',
          environmentId: 'codex',
          operation: 'prompt',
          summary: 'This task can modify files.',
        },
      ],
    });
    expect(rows).toEqual([
      {
        approvalId: 'a1',
        cls: 'workspace_write',
        runId: 'run-1',
        environmentId: 'codex',
        operation: 'prompt',
        summary: 'This task can modify files.',
        createdAt: undefined,
      },
    ]);
  });

  it('accepts a pending list and drops rows without an id', () => {
    const rows = approvalRowsFromUnknown({
      pending: [{ id: 'b2', risk: 'credential' }, { type: 'read' }, null],
    });
    expect(rows.map((row) => row.approvalId)).toEqual(['b2']);
    expect(rows[0].cls).toBe('credential');
  });

  it('fails closed to unknown for an unfamiliar class', () => {
    const rows = approvalRowsFromUnknown({ approvals: [{ approvalId: 'c3', type: 'shell' }] });
    expect(rows[0].cls).toBe('unknown');
  });

  it('reads junk as no approvals', () => {
    expect(approvalRowsFromUnknown(null)).toEqual([]);
    expect(approvalRowsFromUnknown({ approvals: 'nope' })).toEqual([]);
  });
});

describe('batch approval is read-only only', () => {
  const row = (approvalId: string, cls: Parameters<typeof approvalClassLabel>[0]) => ({ approvalId, cls });
  it('keeps read-only rows and drops every other class', () => {
    const rows = [row('a', 'read'), row('b', 'destructive'), row('c', 'unknown'), row('d', 'read')];
    expect(batchApprovableRows(rows).map((entry) => entry.approvalId)).toEqual(['a', 'd']);
  });

  it('an all-destructive batch has nothing to approve', () => {
    expect(batchApprovableRows([row('a', 'credential'), row('b', 'bypass')])).toEqual([]);
  });
});

describe('copy', () => {
  it('prefers the summary and falls back to the class sentence', () => {
    expect(approvalInboxCopy({ approvalId: 'a', cls: 'read', summary: 'Overwrite the file?' })).toBe(
      'Overwrite the file?',
    );
    expect(approvalInboxCopy({ approvalId: 'a', cls: 'workspace_write' })).toBe(
      'A workspace write command needs your approval.',
    );
  });

  it('labels a class as words', () => {
    expect(approvalClassLabel('host_write')).toBe('host write');
  });
});

describe('Activity mounts the inbox', () => {
  it('renders ApprovalInbox and refreshes it on pull', () => {
    const activity = readSource(['src', 'app', '(tabs)', 'activity.tsx']);
    expect(activity).toContain("import { ApprovalInbox } from '@/components/activity/approval-inbox'");
    expect(activity).toContain('<ApprovalInbox');
    expect(activity).toContain('refreshPendingApprovals');
  });

  it('the inbox offers a fail-closed batch control', () => {
    const inbox = readSource(['src', 'components', 'activity', 'approval-inbox.tsx']);
    expect(inbox).toContain('batchApprovableRows');
    expect(inbox).toContain('Deny all');
  });
});

function readInbox(): string {
  return readSource(['src', 'components', 'activity', 'approval-inbox.tsx']);
}

function readProvider(): string {
  return readSource(['src', 'context', 'gateway-provider.tsx']);
}

// The pending list started [] and refreshPendingApprovals folded every
// refusal back into [], so in-flight and failed both claimed "No approvals
// are waiting." The provider must settle three phases and the card must
// branch on them — the empty caption only from a completed, successful read.
describe('Approvals card tells loading, failed, and empty apart', () => {
  test('the provider tracks the pending read as loading, ready, or failed', () => {
    const src = readProvider();
    expect(src).toMatch(/useState<'loading' \| 'ready' \| 'failed'>\('loading'\)/);
    expect(src).toMatch(/setPendingApprovalsState\('failed'\)/);
    expect(src).toMatch(/setPendingApprovalsState\('ready'\)/);
    // A refusal keeps its message instead of vanishing into a silent [].
    expect(src).toContain('setPendingApprovalsError(');
  });

  test('while the read is in flight the card shows a Skeleton, never the empty caption', () => {
    const src = readInbox();
    const loadingAt = src.indexOf("pendingApprovalsState === 'loading'");
    const skeletonAt = src.indexOf('<Skeleton');
    const readyAt = src.indexOf("pendingApprovalsState === 'ready'");
    const emptyAt = src.indexOf('No approvals are waiting.');
    expect(loadingAt).toBeGreaterThanOrEqual(0);
    expect(skeletonAt).toBeGreaterThan(loadingAt);
    expect(readyAt).toBeGreaterThan(loadingAt);
    // The empty caption is only reachable from the ready branch.
    expect(emptyAt).toBeGreaterThan(readyAt);
  });

  test('a failed read renders an ErrorCard with a retry, not the empty caption', () => {
    const src = readInbox();
    const failedAt = src.indexOf("pendingApprovalsState === 'failed'");
    expect(failedAt).toBeGreaterThanOrEqual(0);
    const errorCardAt = src.indexOf('<ErrorCard', failedAt);
    expect(errorCardAt).toBeGreaterThan(failedAt);
    expect(src.slice(failedAt)).toMatch(/onRetry=\{[\s\S]*refreshPendingApprovals/);
    const readyAt = src.indexOf("pendingApprovalsState === 'ready'");
    expect(readyAt).toBeGreaterThan(failedAt);
    const emptyAt = src.indexOf('No approvals are waiting.');
    expect(emptyAt).toBeGreaterThan(readyAt);
  });

  test('the ready branch keeps the empty caption, the batch controls, and the rows', () => {
    const src = readInbox();
    // Fail-closed batch filter still feeds the branch (derived at the top).
    expect(src).toContain('batchApprovableRows(pendingApprovals)');
    const readyAt = src.indexOf("pendingApprovalsState === 'ready'");
    expect(readyAt).toBeGreaterThanOrEqual(0);
    const readyBody = src.slice(readyAt);
    expect(readyBody).toContain('No approvals are waiting.');
    expect(readyBody).toContain('approvable.length > 0');
    expect(readyBody).toContain('Deny all');
    expect(readyBody).toContain('approvalBusy === row.approvalId');
  });
});

// decideApproval rejects with no catch at the provider (try/finally only)
// and every call site was `void`, so a Gate refusal cleared busy and left
// the row pending with zero feedback. The inbox catches and names it.
describe('a refused Approve/Deny names the failure', () => {
  test('single and batch decisions catch the refusal and record a message', () => {
    const src = readInbox();
    expect(src).toContain('setDecideError(');
    // Both paths: the one-row wrapper and the batch loop.
    const decideAt = src.indexOf('const decide =');
    const decideAllAt = src.indexOf('const decideAll =');
    expect(decideAt).toBeGreaterThanOrEqual(0);
    expect(decideAllAt).toBeGreaterThan(decideAt);
    expect(src.slice(decideAt, decideAllAt)).toMatch(/catch \(caught\)/);
    expect(src.slice(decideAllAt)).toMatch(/catch \(caught\)/);
    // The row buttons route through the wrapper, not the raw provider call.
    expect(src).toContain("onPress={() => void decide(row.approvalId, 'approve')}");
    expect(src).toContain("onPress={() => void decide(row.approvalId, 'deny')}");
    expect(src).toContain('void decideAll(');
  });

  test('the refusal renders as an ErrorCard above the list, dismissible', () => {
    const src = readInbox();
    const decideErrAt = src.indexOf('{decideError ?');
    expect(decideErrAt).toBeGreaterThanOrEqual(0);
    const errorCardAt = src.indexOf('<ErrorCard', decideErrAt);
    expect(errorCardAt).toBeGreaterThan(decideErrAt);
    expect(src.slice(decideErrAt, decideErrAt + 600)).toMatch(/onDismiss=\{[\s\S]*setDecideError\(null\)/);
    // It sits above the list branches so a failed tap is never scrolled past.
    const loadingAt = src.indexOf("pendingApprovalsState === 'loading'");
    expect(loadingAt).toBeGreaterThan(decideErrAt);
  });

  test('a successful decision clears the notice', () => {
    const src = readInbox();
    const decideAt = src.indexOf('const decide =');
    const decideAllAt = src.indexOf('const decideAll =');
    expect(src.slice(decideAt, decideAllAt)).toMatch(/setDecideError\(null\)/);
    expect(src.slice(decideAllAt)).toMatch(/setDecideError\(null\)/);
  });
});

describe('the Bot detail sheet carries the opt-in', () => {
  it('mounts the policy row', () => {
    const sheet = readSource(['src', 'components', 'chat', 'bot-detail-sheet.tsx']);
    expect(sheet).toContain("import { BotApprovalPolicyRow } from '@/components/chat/bot-approval-policy'");
    expect(sheet).toContain('<BotApprovalPolicyRow');
  });

  it('the toggle only stores a read-only opt-in', () => {
    const row = readSource(['src', 'components', 'chat', 'bot-approval-policy.tsx']);
    expect(row).toContain('setApprovalPolicy');
    expect(row).toContain('approvalPolicyCopy');
  });
});

describe('Settings shows the decision history', () => {
  it('reads the audit and renders the rows', () => {
    const settings = readSource(['src', 'app', 'gateway', 'settings.tsx']);
    expect(settings).toContain('loadApprovalAudit');
    expect(settings).toContain('approvalAuditCopy');
    expect(settings).toContain('Decision history');
  });
});
