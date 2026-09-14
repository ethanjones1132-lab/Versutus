// Source pins: the Activity tab's "Recent decisions" fold — a failed read of
// the audit key is an empty record (a refused answer is a fact too, ADR-0008
// fail-closed: no audit row still names the decision that was asked), and the
// summary copy is derived from the rows themselves, never invented.

import * as fs from 'fs';
import * as path from 'path';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

import { approvalAuditSummary } from '@/lib/gateway/approval-audit';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const activity = read('src/app/(tabs)/activity.tsx');
const audit = read('src/lib/gateway/approval-audit.ts');

describe('the Activity approvals surface reads the D1 audit back', () => {
  test('the screen loads the audit beside the run it names', () => {
    expect(activity).toContain("from '@/lib/gateway/approval-audit'");
    expect(activity).toContain('loadApprovalAudit');
  });

  test('the audit read is paused with the screen, not leaked across gateways', () => {
    expect(activity).toMatch(/let live = true[\s\S]{0,800}loadApprovalAudit/g);
    expect(activity).toMatch(/return \(\) => \{\s*live = false;\s*\};/);
  });

  test('the summary rides the audit fold, not an inline recount', () => {
    expect(activity).toContain('approvalAuditSummary');
  });

  test('the audit module exports the summary fold the screen folds with', () => {
    expect(audit).toContain('export function approvalAuditSummary');
  });
});

describe('the summary fold answers honestly from the rows', () => {
  test('a zero-row read is an honest empty, not a fabricated verdict', () => {
    expect(approvalAuditSummary([])).toEqual({
      approveCount: 0,
      denyCount: 0,
      latest: null,
    });
  });

  test('it counts each verdict and names the newest row', () => {
    const rows = [
      { runId: 'r2', prompt: 'b', verdict: 'deny' as const, decidedAt: 20, gatewayId: 'gw' },
      { runId: 'r1', prompt: 'a', verdict: 'approve' as const, decidedAt: 10, gatewayId: 'gw' },
    ];
    expect(approvalAuditSummary(rows)).toEqual({
      approveCount: 1,
      denyCount: 1,
      latest: rows[0],
    });
  });
});
