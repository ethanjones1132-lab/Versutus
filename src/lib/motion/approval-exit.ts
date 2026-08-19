export type ApprovalExit = 'idle' | 'approving' | 'denying';

export type ApprovalExitAction = 'approve' | 'deny' | 'reset';

export function nextApprovalExit(current: ApprovalExit, action: ApprovalExitAction): ApprovalExit {
  if (action === 'reset') return 'idle';
  if (current !== 'idle') return current;
  return action === 'approve' ? 'approving' : 'denying';
}

export function approvalExitDuration(kind: ApprovalExit): number {
  if (kind === 'approving') return 280;
  if (kind === 'denying') return 320;
  return 0;
}
