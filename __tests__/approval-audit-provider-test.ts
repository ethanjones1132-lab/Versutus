// Source pins: the provider's approval resolver appends to the D1 audit
// record before handing the decision to the run path — one row per resolved
// decision, fire-and-forget so the run API is never delayed by the audit.

import * as fs from 'fs';
import * as path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('the approval resolver records the D1 audit decision', () => {
  const source = read('src/context/gateway-provider.tsx');
  const body = source.match(/const resolveRunApproval = [\s\S]{0,1800}\},\s*\[[^\]]*\]\);/);
  expect(body).not.toBeNull();
  const text = body![0];

  test('resolveRunApproval appends to the audit before resolving the run path', () => {
    const recordIndex = text.indexOf('recordApprovalDecision({');
    const resolveIndex = text.indexOf('runApprovalResolverRef.current?.(');
    expect(recordIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(recordIndex);
  });

  test('the record is fire-and-forget and names the verdict it resolved', () => {
    expect(text).toContain('void recordApprovalDecision({');
    expect(text).toMatch(/verdict: approved \? 'approve' : 'deny'/);
    expect(text).toContain('runId: pending.runId');
    expect(text).toContain('prompt: pending.prompt');
  });

  test('the record\u2019s gateway scope comes from the active gateway, resolver shape kept', () => {
    expect(text).toContain("gatewayId: activeGatewayRef.current?.id ?? ''");
    expect(text).toContain('runApprovalResolverRef.current = null;');
    expect(text).toContain('setPendingRunApproval(null);');
  });

  test('the provider imports the audit module, not a second spelling of it', () => {
    expect(source).toContain(
      "import { recordApprovalDecision } from '@/lib/gateway/approval-audit';",
    );
  });
});

describe('the run API path is byte-identical', () => {
  test('resolveApproval inside the run orchestration is unchanged', () => {
    const runs = read('src/lib/gateway/runs.ts');
    expect(runs).toContain(
      'await client.resolveApproval(runId, decision.approved, decision.feedback).catch(() => undefined);',
    );
  });
});
