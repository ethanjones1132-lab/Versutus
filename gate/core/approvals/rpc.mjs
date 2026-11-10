// ─── Approval inbox RPC ───────────────────────────────────────────
// The Gate holds pending approvals (CLI environment runs), each already
// classified by the ApprovalService. This exposes them to a paired phone so an
// approval can be triaged from an inbox, not only from the run that raised it.
// Fail closed: the class is the Gate's own, an unknown id decides nothing, and
// every method needs an operator — a paired-device grant, or the Gate's own
// (bootstrap) token. That token is already full operator access, so refusing
// it the inbox protected nothing; it only left a phone holding it reading
// "A paired device grant is required" under Needs you (push-rpc.mjs accepts
// it for the same reason).

function requireDevice(ctx) {
  const deviceId = ctx?.deviceId;
  if (typeof deviceId === 'string' && deviceId.length > 0) return deviceId;
  if (ctx?.bootstrap === true) return 'bootstrap';
  const error = new Error('A paired device grant is required');
  error.status = 403;
  error.code = 'pairing_required';
  throw error;
}

function rpcError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function decide(store, approvalId, decision, params = {}) {
  const id = typeof approvalId === 'string' ? approvalId.trim() : '';
  if (!id) throw rpcError('approvalId is required', 400, 'invalid_request');
  if (!store || typeof store.decide !== 'function') {
    throw rpcError('This Gate cannot decide approvals.', 501, 'approvals_unavailable');
  }
  const pending = store.get(id);
  if (!pending) throw rpcError(`Unknown approval "${id}"`, 404, 'unknown_approval');
  if (pending.request?.adapterId === 'opencode') {
    const namedDecisions = [params.decision, params.reply].filter((value) => value !== undefined);
    const expected = decision === 'approve' ? new Set(['approve', 'once']) : new Set(['deny', 'reject']);
    if (namedDecisions.some((value) => !expected.has(value))) {
      throw rpcError('OpenCode approvals support only once (approve) or reject (deny)', 400, 'invalid_approval_decision');
    }
    const owner = pending.request;
    const claims = [
      ['backendId', owner.backendId ?? owner.environmentId],
      ['environmentId', owner.environmentId],
      ['botId', owner.botId],
      ['sessionId', owner.sessionId ?? owner.runId],
    ];
    for (const [field, expected] of claims) {
      if (params[field] !== undefined && params[field] !== expected) {
        throw rpcError(`Approval ${field} does not match its owner`, 403, 'approval_owner_mismatch');
      }
    }
  }
  const entry = await store.decide(id, decision);
  if (pending.request?.adapterId === 'opencode' && (!entry?.approvalId || entry.reason === 'unknown approval')) {
    throw rpcError(`Unknown approval "${id}"`, 404, 'unknown_approval');
  }
  return { approvalId: entry.approvalId, decision: entry.decision };
}

export function createApprovalRpc({ approvals = null } = {}) {
  const methods = {
    'approvals.pending': async (_params, ctx) => {
      requireDevice(ctx);
      return { approvals: typeof approvals?.list === 'function' ? approvals.list() : [] };
    },

    'approval.approve': async (params = {}, ctx) => {
      requireDevice(ctx);
      return decide(approvals, params.approvalId, 'approve', params);
    },

    'approval.deny': async (params = {}, ctx) => {
      requireDevice(ctx);
      return decide(approvals, params.approvalId, 'deny', params);
    },
  };

  return { methods };
}
