import { approvalExitDuration, nextApprovalExit } from '@/lib/motion/approval-exit';

describe('nextApprovalExit', () => {
  test('idle accepts approve and deny', () => {
    expect(nextApprovalExit('idle', 'approve')).toBe('approving');
    expect(nextApprovalExit('idle', 'deny')).toBe('denying');
  });

  test('a second tap while exiting is a no-op', () => {
    expect(nextApprovalExit('approving', 'deny')).toBe('approving');
    expect(nextApprovalExit('denying', 'approve')).toBe('denying');
    expect(nextApprovalExit('approving', 'approve')).toBe('approving');
  });

  test('reset returns idle from any state', () => {
    expect(nextApprovalExit('approving', 'reset')).toBe('idle');
    expect(nextApprovalExit('denying', 'reset')).toBe('idle');
    expect(nextApprovalExit('idle', 'reset')).toBe('idle');
  });
});

describe('approvalExitDuration', () => {
  test('matches the choreography table', () => {
    expect(approvalExitDuration('idle')).toBe(0);
    expect(approvalExitDuration('approving')).toBe(280);
    expect(approvalExitDuration('denying')).toBe(320);
  });
});
