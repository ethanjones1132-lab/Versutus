import { randomBytes } from 'node:crypto';

const AUTO_APPROVE = new Set(['read']);
const REQUIRE_DECISION = new Set([
  'credential',
  'install',
  'update',
  'plugin',
  'system',
  'destructive',
  'bypass',
  'workspace_write',
  'host_write',
]);

export class ApprovalService {
  constructor() {
    this.pending = new Map();
  }

  async normalize(request = {}) {
    const type = request.type || 'unknown';
    if (AUTO_APPROVE.has(type)) {
      return { decision: 'approve', type };
    }
    if (!REQUIRE_DECISION.has(type)) {
      return { decision: 'deny', type, reason: 'unknown approval type' };
    }
    const approvalId = randomBytes(8).toString('hex');
    const entry = { approvalId, type, request, decision: 'pending' };
    this.pending.set(approvalId, entry);
    return entry;
  }

  async decide(approvalId, decision) {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return { decision: 'deny', reason: 'unknown approval' };
    }
    entry.decision = decision === 'approve' ? 'approve' : 'deny';
    this.pending.delete(approvalId);
    return entry;
  }
}
