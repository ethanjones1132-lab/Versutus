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
    // Resolvers parked by waitForDecision, keyed by approvalId.
    this.waiters = new Map();
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

  /**
   * Resolves with the ruling once decide() answers it, or null for an id
   * that was never (or is no longer) pending. This is the supervisor's seat
   * while a risky operation sits in front of the operator's Approve/Deny
   * card: nothing spawns until this resolves.
   */
  waitForDecision(approvalId) {
    const entry = this.pending.get(approvalId);
    if (!entry) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(approvalId) ?? new Set();
      waiters.add(resolve);
      this.waiters.set(approvalId, waiters);
    });
  }

  async decide(approvalId, decision) {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return { decision: 'deny', reason: 'unknown approval' };
    }
    entry.decision = decision === 'approve' ? 'approve' : 'deny';
    this.pending.delete(approvalId);
    const waiters = this.waiters.get(approvalId);
    if (waiters) {
      this.waiters.delete(approvalId);
      for (const resolve of waiters) resolve(entry);
    }
    return entry;
  }
}
