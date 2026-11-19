import { randomBytes } from 'node:crypto';
import { deviceTag } from '../voice/audit.mjs';
import { actionClass, approvalIdentifier, safeActionSummary, VOICE_APPROVAL_DEADLINE_MS } from '../approvals/action-class.mjs';

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
  constructor({ ledger = null, now = Date.now } = {}) {
    this.ledger = ledger;
    this.now = now;
    this.closed = false;
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
    return this.open(type, request);
  }

  open(type, request, { strict = false, kind = actionClass(request.operation ?? type) } = {}) {
    if (this.closed) return { decision: 'deny' };
    const approvalId = randomBytes(8).toString('hex');
    const createdAt = new Date(this.now()).toISOString();
    const summary = safeActionSummary(kind, request.operation);
    const session = request.sessionId ?? request.runId;
    const record = {
      approvalId, requestedAt: createdAt,
      source: strict || request.voiceDeviceId ? 'voice' : 'typed',
      backend: approvalIdentifier(request.backendId ?? request.environmentId),
      bot: approvalIdentifier(request.botId),
      sessionTag: typeof session === 'string' && session ? deviceTag(`session:${session}`) : null,
      actionClass: kind, tool: approvalIdentifier(request.operation), summary,
    };
    // A faulty ledger may not grant voice execution. Existing typed paths
    // still work as before if their optional audit write fails.
    try { this.ledger?.begin(record); }
    catch (error) {
      if (strict) throw error;
      console.warn('approvals: could not record pending typed decision');
    }
    const entry = { approvalId, type, request, decision: 'pending', createdAt };
    // Internal bookkeeping must not change the existing typed run REST shape.
    Object.defineProperties(entry, {
      record: { value: record },
      strict: { value: strict },
      deadline: { value: undefined, writable: true },
      outcome: { value: undefined, writable: true },
    });
    this.pending.set(approvalId, entry);
    return entry;
  }

  /** Called before dispatch (or while a native tool request is parked). */
  async authorize({ tool, external, backendId, botId, sessionId, deviceId, signal, announce,
    timeoutMs = VOICE_APPROVAL_DEADLINE_MS, legacySummary, requireDecision = false } = {}) {
    if (this.closed || signal?.aborted) return false;
    const kind = actionClass(tool, { external });
    if ((requireDecision || kind !== 'read') && !deviceId) return false;
    const summary = legacySummary ?? safeActionSummary(kind, tool);
    const entry = this.open(kind, {
      voiceDeviceId: deviceId, backendId, environmentId: backendId, botId,
      sessionId, runId: sessionId, operation: tool, summary,
    }, { strict: true, kind });
    const { approvalId } = entry;
    if (!approvalId) return false;
    if (!requireDecision && kind === 'read') return this.settle(entry, 'approved').decision === 'approve';
    const budget = Math.min(VOICE_APPROVAL_DEADLINE_MS, Math.max(0, timeoutMs));
    entry.deadline = Date.parse(entry.createdAt) + budget;
    const waiting = this.waitForDecision(approvalId);
    const notify = (state) => {
      try { announce?.({ approvalId, summary, state, gateDecision: true }); } catch { /* observer only */ }
    };
    const abort = () => this.settle(entry, 'withdrawn');
    const timer = setTimeout(() => this.settle(entry, 'expired'), Math.max(0, entry.deadline - this.now()));
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    notify('pending');
    try {
      const ruling = await waiting;
      notify(ruling?.outcome === 'expired' ? 'expired' : ruling?.decision === 'approve' ? 'approved' : 'denied');
      return ruling?.decision === 'approve' && !signal?.aborted;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  recent(limit) { return this.ledger?.recent(limit) ?? []; }

  close() {
    this.closed = true;
    for (const entry of this.pending.values()) this.settle(entry, 'gate-restart');
    this.ledger?.close();
  }

  get(approvalId) {
    return this.pending.get(approvalId) ?? null;
  }

  /**
   * The phone's inbox rows. Deliberately a projection, never the raw request
   * bag: the request carries whatever the backend sent (paths, prompts) and the
   * inbox needs only the class and the one-line summary the Gate composed.
   */
  list({ deviceId, bootstrap = false } = {}) {
    return [...this.pending.values()].filter((entry) => (
      !entry.request?.voiceDeviceId || entry.request.voiceDeviceId === deviceId
      || (bootstrap && entry.request.voiceDeviceId.startsWith('bootstrap:'))
    )).map((entry) => ({
      approvalId: entry.approvalId,
      type: entry.type,
      runId: entry.request?.runId ?? null,
      environmentId: entry.request?.environmentId ?? null,
      operation: entry.request?.operation ?? null,
      summary: entry.request?.summary ?? null,
      ...(entry.strict ? { botId: entry.request?.botId ?? null } : {}),
      ...(entry.request?.adapterId === 'opencode' ? {
        backendId: entry.request?.backendId ?? entry.request?.environmentId ?? null,
        adapterId: 'opencode',
        botId: entry.request?.botId ?? null,
        sessionId: entry.request?.sessionId ?? entry.request?.runId ?? null,
        context: entry.request?.context ?? null,
      } : {}),
      createdAt: entry.createdAt,
    }));
  }

  /** Remove a native request which OpenCode resolved outside this inbox. */
  withdraw(approvalId, reason = 'approval is no longer pending') {
    const entry = this.pending.get(approvalId);
    if (!entry) return null;
    entry.withdrawReason = reason;
    return this.settle(entry, 'withdrawn');
  }

  settle(entry, outcome, deviceId) {
    const { approvalId } = entry;
    if (this.pending.get(approvalId) !== entry) return null;
    try { this.ledger?.record(entry.record, outcome, deviceId); }
    catch {
      console.warn('approvals: could not record decision');
      if (entry.strict && outcome === 'approved') outcome = 'withdrawn';
    }
    this.pending.delete(approvalId);
    entry.outcome = outcome;
    entry.decision = outcome === 'approved' ? 'approve' : 'deny';
    if (outcome === 'withdrawn' || outcome === 'gate-restart') entry.withdrawn = true;
    const waiters = this.waiters.get(approvalId);
    if (waiters) {
      this.waiters.delete(approvalId);
      for (const resolve of waiters) resolve(entry);
    }
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

  async decide(approvalId, decision, { deviceId, outcome } = {}) {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return { decision: 'deny', reason: 'unknown approval' };
    }
    if (entry.request?.voiceDeviceId && deviceId !== entry.request.voiceDeviceId) {
      const error = new Error('Approval does not belong to this device');
      error.code = 'approval_owner_mismatch';
      error.status = 403;
      throw error;
    }
    if (entry.strict && this.now() >= entry.deadline) {
      this.settle(entry, 'expired');
      return { decision: 'deny', reason: 'unknown approval' };
    }
    if (entry.strict && entry.type === 'unknown' && decision === 'approve') {
      // An adapter/version the Gate cannot classify may not turn an opaque
      // request into execution, even if the operator taps Approve.
      return this.settle(entry, 'denied', deviceId);
    }
    if (entry.request?.adapterId === 'opencode' && decision !== 'approve' && decision !== 'deny') {
      const error = new Error('OpenCode approvals support only once (approve) or reject (deny)');
      error.status = 400;
      error.code = 'invalid_approval_decision';
      throw error;
    }
    if (entry.request?.adapterId === 'opencode' && typeof entry.request.onDecision === 'function') {
      if (entry.deciding) {
        const error = new Error('OpenCode permission decision is already being forwarded');
        error.status = 409;
        error.code = 'approval_decision_in_progress';
        throw error;
      }
      entry.deciding = true;
      try {
        await entry.request.onDecision(decision === 'approve' ? 'once' : 'reject');
      } finally {
        entry.deciding = false;
      }
      // OpenCode may have resolved the request on another client while this
      // reply was in flight. Its lifecycle event remains authoritative.
      if (this.pending.get(approvalId) !== entry) {
        const error = new Error('OpenCode permission request is no longer pending');
        error.status = 404;
        error.code = 'unknown_approval';
        throw error;
      }
    }
    return this.settle(entry, decision === 'approve' ? 'approved' : outcome ?? 'denied', deviceId);
  }
}
