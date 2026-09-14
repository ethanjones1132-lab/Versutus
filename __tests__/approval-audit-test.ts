jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  APPROVAL_AUDIT_KEY_PREFIX,
  APPROVAL_AUDIT_ROW_CAP,
  type ApprovalAuditEntry,
  approvalAuditSummary,
  loadApprovalAudit,
  recordApprovalDecision,
} from '@/lib/gateway/approval-audit';

function entry(gatewayId: string, decidedAt: number, verdict: 'approve' | 'deny') {
  return {
    gatewayId,
    runId: `run-${decidedAt}`,
    prompt: 'ship it',
    verdict,
    decidedAt,
  } as ApprovalAuditEntry;
}

describe('recordApprovalDecision', () => {
  test('appends to the gateway-scoped key as JSON rows newest-first', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await recordApprovalDecision(entry('gw-1', 100, 'approve'));
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'versutus:approval-audit:gw-1',
      JSON.stringify([
        { runId: 'run-100', prompt: 'ship it', verdict: 'approve', decidedAt: 100 },
      ]),
    );
  });

  test('an empty gateway id is a no-op — nowhere to record against', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await recordApprovalDecision(entry('', 100, 'approve'));
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('is best-effort rather than throwing over storage failure', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk'));
    await expect(recordApprovalDecision(entry('gw-1', 100, 'deny'))).resolves.toBeUndefined();
  });
});

describe('loadApprovalAudit', () => {
  test('reads back recorded rows newest-first', async () => {
    const rows = [
      { runId: 'run-2', prompt: 'b', verdict: 'deny' as const, decidedAt: 2 },
      { runId: 'run-1', prompt: 'a', verdict: 'approve' as const, decidedAt: 1 },
    ];
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(rows));
    expect(await loadApprovalAudit('gw-1')).toEqual(rows);
  });

  test('keeps the fold inside the same cap at load time', async () => {
    const rows = Array.from({ length: APPROVAL_AUDIT_ROW_CAP + 5 }, (_, i) => ({
      runId: `run-${i}`,
      prompt: 'p',
      verdict: 'approve' as const,
      decidedAt: i,
    }));
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(rows));
    expect((await loadApprovalAudit('gw-1')).length).toBe(APPROVAL_AUDIT_ROW_CAP);
  });

  test('dropped fields are dropped, not guessed — the deny row keeps its own verdict', async () => {
    const rows = [
      { runId: 'run-1', prompt: 'a', verdict: 'approve', decidedAt: 1 },
      { runId: 42, verdict: 'deny', decidedAt: 2 },
      { verdict: 'deny', decidedAt: 3 },
      'not-a-row',
      null,
    ];
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(rows));
    expect(await loadApprovalAudit('gw-1')).toEqual([rows[0]]);
  });

  test('rows on disk are returned as stored, preserving record order for the caller', async () => {
    const rows = [
      { runId: 'run-1', prompt: 'a', verdict: 'approve', decidedAt: 1 },
      { runId: 'run-2', prompt: 'b', verdict: 'deny', decidedAt: 2 },
    ];
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(rows));
    expect(await loadApprovalAudit('gw-1')).toEqual(rows);
  });

  test('an empty/corrupt record is an empty list, never an invention', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    expect(await loadApprovalAudit('gw-none')).toEqual([]);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not json{');
    expect(await loadApprovalAudit('gw-1')).toEqual([]);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('"a string"');
    expect(await loadApprovalAudit('gw-1')).toEqual([]);
  });
});

describe('approvalAuditSummary', () => {
  test('counts approves and denies and names the most recent decision', () => {
    const rows = [
      entry('gw', 30, 'deny'),
      entry('gw', 20, 'approve'),
      entry('gw', 10, 'approve'),
    ];
    expect(approvalAuditSummary(rows)).toEqual({
      approveCount: 2,
      denyCount: 1,
      latest: { gatewayId: 'gw', runId: 'run-30', prompt: 'ship it', verdict: 'deny', decidedAt: 30 },
    });
  });

  test('an empty record is zero counts and no most-recent decision', () => {
    expect(approvalAuditSummary([])).toEqual({
      approveCount: 0,
      denyCount: 0,
      latest: null,
    });
  });

  test('latest is the decidedAt max regardless of row order', () => {
    const rows = [entry('gw', 10, 'deny'), entry('gw', 40, 'approve'), entry('gw', 20, 'deny')];
    expect(approvalAuditSummary(rows).latest).toEqual(
      expect.objectContaining({ verdict: 'approve', decidedAt: 40 }),
    );
  });
});
