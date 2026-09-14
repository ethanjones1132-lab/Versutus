// Source pins: a waiting run approval is pre-decided ONCE by this Bot's
// policy at the approval-waiting point, and even a policy-decided verdict
// rides the SAME audit row a human decision writes — marked decided-by-policy.

import * as fs from 'fs';
import * as path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('the provider pre-decides a waiting approval by policy', () => {
  const source = read('src/context/gateway-provider.tsx');
  const waiting = source.match(/onApprovalRequired: \(runId\) => \{[\s\S]{0,4000}?\n\s*\},\n\s*\}\);/);
  expect(waiting).not.toBeNull();
  const text = waiting![0];

  test('the waiting point consults the policy fold before pending', () => {
    expect(text).toContain('approvalPolicyVerdict');
    expect(text).toContain('loadBotApprovalPolicy');
  });

  test('a defer verdict pends exactly as today — the banner still shows', () => {
    expect(text).toContain("decision !== 'auto-approve'");
    expect(text).toContain('setPendingRunApproval({ runId, prompt })');
  });

  test('a policy verdict resolves the SAME promise path the human resolver drives', () => {
    // The policy pre-decision rides runApprovalResolverRef so patchRun /
    // resolve / clear state are byte-identical to a finger writing them.
    expect(text).toContain('runApprovalResolverRef.current?.(true, undefined);');
    expect(text).toMatch(/runApprovalResolverRef\.current\?\.\((\s|\n)*true,(\s|\n)*undefined/);
  });

  test('a policy decision is recorded through the SAME audit append, marked decided-by-policy', () => {
    expect(text).toContain("decidedBy: 'policy'");
    expect(text).toContain('recordApprovalDecision');
    expect(text).toMatch(/verdict: 'approve'/);
  });
});
