/**
 * Connect OpenCode's native permission lifecycle to the Gate inbox. OpenCode
 * remains authoritative: a decision is sent only for the exact owner tuple
 * captured on its asked event, and a native resolution withdraws the inbox row.
 */
export function assertOpenCodeReply(reply) {
  if (reply !== 'once' && reply !== 'reject') {
    const error = new Error('OpenCode permission reply must be "once" or "reject"');
    error.status = 400;
    error.code = 'invalid_permission_reply';
    throw error;
  }
}

export function createOpenCodePermissionBridge({
  approvals,
  backendId,
  environmentId = backendId,
  timeoutMs = 120_000,
  replyApproval,
} = {}) {
  const byNativeId = new Map();
  const sending = new Set();
  const openingIds = new Map();
  const resolvedDuringOpen = new Set();
  let sendReply = replyApproval;

  async function asked(event, botId = null) {
    const request = event?.properties ?? event?.data ?? {};
    const sessionId = request.sessionID;
    const requestId = request.id;
    if (typeof sessionId !== 'string' || typeof requestId !== 'string'
      || byNativeId.has(requestId) || openingIds.has(requestId)) return;
    openingIds.set(requestId, sessionId);

    const permission = request.action ?? request.permission ?? 'unknown';
    const resources = request.resources ?? request.patterns ?? [];
    const context = {
      permission,
      tool: typeof request.metadata?.tool === 'string' ? request.metadata.tool : null,
      command: typeof request.metadata?.command === 'string' ? request.metadata.command : null,
      resources: Array.isArray(resources) ? resources : [],
      patterns: Array.isArray(request.patterns) ? request.patterns : [],
      save: Array.isArray(request.save) ? request.save : Array.isArray(request.always) ? request.always : [],
      metadata: {
        ...(typeof request.metadata?.command === 'string' ? { command: request.metadata.command } : {}),
        ...(typeof request.metadata?.tool === 'string' ? { tool: request.metadata.tool } : {}),
        ...(typeof request.metadata?.description === 'string' ? { description: request.metadata.description } : {}),
      },
      source: request.source ?? request.tool ?? null,
    };
    let normalized;
    try {
      normalized = await approvals.normalize({
        type: 'workspace_write',
        adapterId: 'opencode',
        backendId: backendId ?? environmentId,
        environmentId,
        botId,
        runId: sessionId,
        sessionId,
        openCodeRequestId: requestId,
        operation: permission,
        summary: [permission, context.command, ...context.resources].filter(Boolean).join(' · ').slice(0, 240),
        context,
        onDecision: async (reply) => {
          if (reply !== 'once' && reply !== 'reject') assertOpenCodeReply(reply);
          if (typeof sendReply !== 'function') throw new Error('OpenCode approval reply handler is unavailable');
          sending.add(requestId);
          let terminal = false;
          try {
            await sendReply(sessionId, requestId, reply);
            terminal = true;
          } catch (error) {
            if (error?.status === 404 || /not found/i.test(String(error?.message ?? ''))) {
              approvals.withdraw(normalized.approvalId, 'OpenCode permission request expired');
              terminal = true;
              if (error?.status !== 404) {
                error.status = 404;
                error.code = 'unknown_approval';
              }
            }
            throw error;
          } finally {
            sending.delete(requestId);
            if (terminal) byNativeId.delete(requestId);
          }
        },
      });
    } catch (error) {
      resolvedDuringOpen.delete(requestId);
      throw error;
    } finally {
      openingIds.delete(requestId);
    }
    // A fresh entry's decision is the string 'pending'; anything else means the
    // service ruled at once (an auto-approved or unknown type) and nothing waits.
    if (!normalized?.approvalId || normalized.decision !== 'pending') {
      resolvedDuringOpen.delete(requestId);
      return;
    }
    byNativeId.set(requestId, { approvalId: normalized.approvalId, sessionId, botId });
    if (resolvedDuringOpen.delete(requestId)) {
      byNativeId.delete(requestId);
      approvals.withdraw(normalized.approvalId, 'OpenCode permission was resolved elsewhere');
      return;
    }

    const waiting = approvals.waitForDecision(normalized.approvalId);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        Promise.resolve(approvals.decide(normalized.approvalId, 'deny')).then(resolve, () => resolve(null));
      }, timeoutMs);
      timer.unref?.();
    });
    let ruling;
    try {
      ruling = await Promise.race([waiting, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!ruling || ruling.withdrawn) return;
    if (byNativeId.get(requestId)?.approvalId === normalized.approvalId) {
      byNativeId.delete(requestId);
    }
  }

  function replied(event) {
    const properties = event?.properties ?? event?.data ?? {};
    const requestId = properties.requestID;
    if (typeof requestId !== 'string') return;
    if (openingIds.get(requestId) === properties.sessionID) {
      resolvedDuringOpen.add(requestId);
      return;
    }
    const pending = byNativeId.get(requestId);
    if (!pending || (properties.sessionID && properties.sessionID !== pending.sessionId)) return;
    if (sending.has(requestId)) return;
    byNativeId.delete(requestId);
    approvals.withdraw(pending.approvalId, 'OpenCode permission was resolved elsewhere');
  }

  function reconcile(sessionId, requests) {
    const pending = new Set((Array.isArray(requests) ? requests : []).map((request) => request?.id));
    for (const [requestId, owner] of byNativeId) {
      if (owner.sessionId !== sessionId || pending.has(requestId)) continue;
      byNativeId.delete(requestId);
      approvals.withdraw(owner.approvalId, 'OpenCode permission request is no longer pending');
    }
  }

  return {
    asked,
    replied,
    reconcile,
    setReplyApproval(handler) { sendReply = handler; },
  };
}
