// ─── Approval policies (D1's policy half) ─────────────────────────────────
// The pure fold deciding what a policy CAN auto-approve, and the copy its
// surfaces state. Matches the spend-cap verdict sibling: the pure module
// imports nothing, so any suite (and slash-commands) can load it raw.

import { approvalPolicyVerdict, APPROVAL_POLICY_LIMIT_COPY } from '@/lib/settings/approval-policy';

describe('approvalPolicyVerdict — the fold a waiting approval is pre-decided with', () => {
  const policy = { enabled: true, readOnlyCommands: ['list', 'read', 'journal'] };

  test('no policy, or a disabled one, defers — the human path is untouched', () => {
    expect(approvalPolicyVerdict(null, 'list the files')).toEqual({ decision: 'defer' });
    expect(approvalPolicyVerdict({ enabled: false, readOnlyCommands: ['list'] }, 'list the files')).toEqual({
      decision: 'defer',
    });
    expect(approvalPolicyVerdict({ enabled: true, readOnlyCommands: [] }, 'list the files')).toEqual({
      decision: 'defer',
    });
  });

  test('a prompt naming a listed read-only command is auto-approved', () => {
    expect(approvalPolicyVerdict(policy, 'list the files')).toEqual({ decision: 'auto-approve' });
    expect(approvalPolicyVerdict(policy, 'READ the notes')).toEqual({ decision: 'auto-approve' });
    expect(approvalPolicyVerdict(policy, 'journal: what happened today')).toEqual({ decision: 'auto-approve' });
  });

  test('the match is the command word, not a substring — `listen` is not `list`', () => {
    expect(approvalPolicyVerdict(policy, 'listen to the stream')).toEqual({ decision: 'defer' });
    expect(approvalPolicyVerdict(policy, 'redelegate the work')).toEqual({ decision: 'defer' });
  });

  test('a prompt matching nothing is deferred, never auto-approved — fail-closed (ADR 0008)', () => {
    expect(approvalPolicyVerdict(policy, 'rm -rf /')).toEqual({ decision: 'defer' });
    expect(approvalPolicyVerdict(policy, '')).toEqual({ decision: 'defer' });
  });
});

describe('APPROVAL_POLICY_LIMIT_COPY — the honest framing the editor states', () => {
  test('the copy names auto-approval and the read-only boundary, opt-in per Bot', () => {
    expect(APPROVAL_POLICY_LIMIT_COPY).toContain('read-only');
    expect(APPROVAL_POLICY_LIMIT_COPY).toContain('this agent');
  });
});
