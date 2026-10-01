// The durable approval audit is one JSON array under one key, and
// `recordApprovalDecision` is a read-modify-write of it. Two rows decided at
// once (the inbox disables a row's buttons only against its own approvalId) each
// read the same snapshot, so whichever write landed second was computed from a
// log that did not hold the first decision — one answer vanished from the only
// durable record the device keeps. And because the writer read through the
// LENIENT loader, one refused read answered `[]` and the write then replaced
// the whole history with a single entry. These pin the queue and the strict
// read, plus the recovery copy for bytes we cannot parse.

const mockStore = new Map<string, string>();

/** What the audit key refuses to answer, when set. */
let mockReadRefusal: Error | null = null;

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: async (key: string): Promise<string | null> => {
      if (mockReadRefusal) throw mockReadRefusal;
      return mockStore.get(key) ?? null;
    },
    setItem: async (key: string, value: string): Promise<void> => {
      mockStore.set(key, value);
    },
    removeItem: async (key: string): Promise<void> => {
      mockStore.delete(key);
    },
  },
}));

import {
  APPROVAL_AUDIT_CORRUPT_STORAGE_KEY,
  APPROVAL_AUDIT_STORAGE_KEY,
  loadApprovalAuditStrict,
  recordApprovalDecision,
  type ApprovalAuditEntry,
} from '@/lib/gateway/approval-policy';

function entry(approvalId: string, at: number): ApprovalAuditEntry {
  return { approvalId, cls: 'read', decision: 'approve', source: 'operator', at };
}

function stored(): ApprovalAuditEntry[] {
  return JSON.parse(mockStore.get(APPROVAL_AUDIT_STORAGE_KEY) ?? '[]') as ApprovalAuditEntry[];
}

beforeEach(() => {
  mockStore.clear();
  mockReadRefusal = null;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('two decisions decided at once keep both rows', () => {
  it('the second write is computed from what the first one wrote', async () => {
    await Promise.all([
      recordApprovalDecision(entry('a1', 1)),
      recordApprovalDecision(entry('a2', 2)),
    ]);

    // Newest first, and both answers are on disk — one lost decision is one
    // operator's answer the Gate's own log can no longer explain.
    expect(stored().map((row) => row.approvalId)).toEqual(['a2', 'a1']);
    await expect(loadApprovalAuditStrict()).resolves.toHaveLength(2);
  });

  it('a burst of eight decisions records eight rows', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => recordApprovalDecision(entry(`b${index}`, index))),
    );
    expect(stored()).toHaveLength(8);
  });
});

describe('a refused audit read never rewrites the stored history', () => {
  it('leaves the stored value exactly as it was and records nothing', async () => {
    const seeded = [entry('kept', 1)];
    mockStore.set(APPROVAL_AUDIT_STORAGE_KEY, JSON.stringify(seeded));
    mockReadRefusal = new Error('storage unavailable');

    await recordApprovalDecision(entry('lost', 2));

    // The bytes the device already held are untouched: a refused read is not
    // an empty log, and the writer must not treat it as one.
    expect(mockStore.get(APPROVAL_AUDIT_STORAGE_KEY)).toBe(JSON.stringify(seeded));
    expect(stored().map((row) => row.approvalId)).toEqual(['kept']);
  });

  it('says so instead of dropping the row silently', async () => {
    mockReadRefusal = new Error('storage unavailable');
    await recordApprovalDecision(entry('lost', 2));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('storage unavailable'));
  });

  it('the next decision records once the mockStore answers again', async () => {
    const seeded = [entry('kept', 1)];
    mockStore.set(APPROVAL_AUDIT_STORAGE_KEY, JSON.stringify(seeded));
    mockReadRefusal = new Error('storage unavailable');
    await recordApprovalDecision(entry('lost', 2));

    mockReadRefusal = null;
    await recordApprovalDecision(entry('after', 3));
    expect(stored().map((row) => row.approvalId)).toEqual(['after', 'kept']);
  });
});

describe('a corrupt audit value is recoverable, not silently overwritten', () => {
  it('keeps the unparsable bytes in the rescue slot and starts a fresh log', async () => {
    mockStore.set(APPROVAL_AUDIT_STORAGE_KEY, '{not json');

    await recordApprovalDecision(entry('new', 1));

    expect(mockStore.get(APPROVAL_AUDIT_CORRUPT_STORAGE_KEY)).toBe('{not json');
    expect(stored().map((row) => row.approvalId)).toEqual(['new']);
  });

  it('the rescue slot is a single key, so the newest unparsable copy wins', async () => {
    mockStore.set(APPROVAL_AUDIT_STORAGE_KEY, '{first');
    await recordApprovalDecision(entry('new', 1));
    mockStore.set(APPROVAL_AUDIT_STORAGE_KEY, '{second');
    await recordApprovalDecision(entry('newer', 2));

    expect(mockStore.get(APPROVAL_AUDIT_CORRUPT_STORAGE_KEY)).toBe('{second');
    expect(stored().map((row) => row.approvalId)).toEqual(['newer']);
  });

  it('an unstoreable rescue copy still lets the decision be recorded', async () => {
    mockStore.set(APPROVAL_AUDIT_STORAGE_KEY, '{not json');
    // The rescue slot refuses first, the audit key accepts.
    const realSet = mockStore.set.bind(mockStore);
    jest.spyOn(mockStore, 'set').mockImplementation((key: string, value: string) => {
      if (key !== APPROVAL_AUDIT_CORRUPT_STORAGE_KEY) realSet(key, value);
      return mockStore;
    });

    await recordApprovalDecision(entry('new', 1));

    expect(mockStore.get(APPROVAL_AUDIT_CORRUPT_STORAGE_KEY)).toBeUndefined();
    expect(stored().map((row) => row.approvalId)).toEqual(['new']);
  });

  it('valid JSON that is not a log reads as a fresh log, unrescued', async () => {
    mockStore.set(APPROVAL_AUDIT_STORAGE_KEY, '{"not":"an array"}');
    await recordApprovalDecision(entry('new', 1));

    expect(mockStore.get(APPROVAL_AUDIT_CORRUPT_STORAGE_KEY)).toBeUndefined();
    expect(stored().map((row) => row.approvalId)).toEqual(['new']);
  });
});