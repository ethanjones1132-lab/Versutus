import { approvalClassLabel, approvalInboxCopy, approvalRowsFromUnknown } from '@/lib/gateway/approvals';

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
