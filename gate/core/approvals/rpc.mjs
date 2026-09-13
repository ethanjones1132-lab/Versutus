// ─── Approval inbox RPC ───────────────────────────────────────────
// The Gate holds pending approvals (CLI environment runs), each already
// classified by the ApprovalService. This exposes them to a paired phone so an
// approval can be triaged from an inbox, not only from the run that raised it.
// Fail closed: the class is the Gate's own, an unknown id decides nothing, and
// every method needs a paired-device grant.

function requireDevice(ctx) {
  const deviceId = ctx?.deviceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    const error = new Error('A paired device grant is required');
    error.status = 403;
    error.code = 'pairing_required';
    throw error;
  }
  return deviceId;
}

function rpcError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function decide(store, approvalId, decision) {
  const id = typeof approvalId === 'string' ? approvalId.trim() : '';
  if (!id) throw rpcError('approvalId is required', 400, 'invalid_request');
  if (!store || typeof store.decide !== 'function') {
    throw rpcError('This Gate cannot decide approvals.', 501, 'approvals_unavailable');
  }
  if (!store.get(id)) throw rpcError(`Unknown approval "${id}"`, 404, 'unknown_approval');
  const entry = await store.decide(id, decision);
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
      return decide(approvals, params.approvalId, 'approve');
    },

    'approval.deny': async (params = {}, ctx) => {
      requireDevice(ctx);
      return decide(approvals, params.approvalId, 'deny');
    },
  };

  return { methods };
}
