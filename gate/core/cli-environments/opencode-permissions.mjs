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
  // A request OpenCode reported resolved while this Gate's own reply was in
  // flight: if that reply then fails, the request was answered elsewhere.
  const supersededWhileSending = new Set();
  const openingIds = new Map();
  // Every request is stamped with the order it was first seen in, so a pending
  // snapshot only judges requests that existed before it was asked for: one
  // that arrives on the stream while the snapshot is in flight is not missing.
  let sequence = 0;
  const seenAt = new Map();
  const resolvedDuringOpen = new Set();
  const voiceTurns = new Map();
  const voiceRequests = new Map();
  let sendReply = replyApproval;
  // Turns watch a card's lifetime: a turn whose approval is still open for a
  // decision is working, not silent, so its idle bound must not run. Watchers
  // hear the moment a card lands in the inbox and the moment it can no longer
  // be decided — whichever way that happened (a ruling, the approval timeout's
  // deny, another client's reply, or a pending snapshot proving it gone).
  const watchers = new Set();
  const approvalWatchers = new Set();
  const notify = (phase, sessionId, requestId, approval) => {
    for (const watcher of watchers) {
      try {
        watcher({ phase, sessionId, requestId });
      } catch {
        /* a watcher must never break the approval it is watching */
      }
    }
    for (const watcher of approvalWatchers) {
      try { watcher({ sessionId, approval }); } catch { /* observers do not decide */ }
    }
  };

  async function askedInVoice(voice, sessionId, requestId, tool) {
    if (voice.seen.has(requestId)) return;
    voice.seen.add(requestId);
    const remote = new AbortController();
    voiceRequests.set(requestId, { sessionId, remote });
    try {
      const allowed = await approvals.authorize({
        tool, backendId: backendId ?? environmentId, botId: voice.botId, sessionId,
        deviceId: voice.deviceId, timeoutMs: voice.timeoutMs, requireDecision: true,
        signal: AbortSignal.any([voice.signal, remote.signal]),
        announce: (card) => notify(card.state === 'pending' ? 'open' : 'settle', sessionId, requestId, card),
      }).catch(() => false);
      if (!remote.signal.aborted) await sendReply?.(sessionId, requestId, allowed ? 'once' : 'reject');
    } finally {
      voiceRequests.delete(requestId);
    }
  }

  async function asked(event, botId = null) {
    const request = event?.properties ?? event?.data ?? {};
    const sessionId = request.sessionID;
    const requestId = request.id;
    if (typeof sessionId !== 'string' || typeof requestId !== 'string'
      || byNativeId.has(requestId) || openingIds.has(requestId)) return;
    const voice = voiceTurns.get(sessionId);
    if (voice) return askedInVoice(voice, sessionId, requestId, request.action ?? request.permission ?? 'unknown');
    openingIds.set(requestId, sessionId);
    seenAt.set(requestId, ++sequence);

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
    const summary = [permission, context.command, ...context.resources].filter(Boolean).join(' · ').slice(0, 240);
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
        summary,
        context,
        onDecision: async (reply) => {
          if (reply !== 'once' && reply !== 'reject') assertOpenCodeReply(reply);
          if (typeof sendReply !== 'function') throw new Error('OpenCode approval reply handler is unavailable');
          sending.add(requestId);
          supersededWhileSending.delete(requestId);
          let terminal = false;
          try {
            await sendReply(sessionId, requestId, reply);
            terminal = true;
          } catch (error) {
            // Only OpenCode's own 404 proves the request is gone. Any other
            // failure (a proxy, DNS, a timeout) leaves it pending and retryable,
            // unless OpenCode already said it was answered elsewhere meanwhile.
            if (error?.status === 404 || supersededWhileSending.has(requestId)) {
              approvals.withdraw(normalized.approvalId, error?.status === 404
                ? 'OpenCode permission request expired'
                : 'OpenCode permission was resolved elsewhere');
              terminal = true;
              if (error?.status !== 404) {
                error.status = 404;
                error.code = 'unknown_approval';
              }
            }
            throw error;
          } finally {
            sending.delete(requestId);
            supersededWhileSending.delete(requestId);
            if (terminal) {
              byNativeId.delete(requestId);
              seenAt.delete(requestId);
            }
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
    // The card is in the inbox and this Gate will wait for its ruling: a turn
    // on this session is not a dead turn until that wait ends.
    const card = { approvalId: normalized.approvalId, summary };
    notify('open', sessionId, requestId, { ...card, state: 'pending' });

    const waiting = approvals.waitForDecision(normalized.approvalId);
    let timer;
    let expired = false;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        Promise.resolve(approvals.decide(normalized.approvalId, 'deny', { outcome: 'expired' })).then(resolve, () => resolve(null));
      }, timeoutMs);
      timer.unref?.();
    });
    let ruling;
    try {
      ruling = await Promise.race([waiting, timeout]);
    } finally {
      clearTimeout(timer);
      // Whatever ended the wait, the inbox no longer accepts a decision, so a
      // turn's clock starts again from this moment.
      notify('settle', sessionId, requestId, {
        ...card, state: expired ? 'expired' : ruling?.decision === 'approve' ? 'approved' : 'denied',
      });
    }
    if (!ruling || ruling.withdrawn) return;
    if (byNativeId.get(requestId)?.approvalId === normalized.approvalId) {
      byNativeId.delete(requestId);
      seenAt.delete(requestId);
    }
  }

  function replied(event) {
    const properties = event?.properties ?? event?.data ?? {};
    const requestId = properties.requestID;
    if (typeof requestId !== 'string') return;
    const voice = voiceRequests.get(requestId);
    if (voice && voice.sessionId === properties.sessionID) voice.remote.abort();
    if (openingIds.get(requestId) === properties.sessionID) {
      resolvedDuringOpen.add(requestId);
      return;
    }
    const pending = byNativeId.get(requestId);
    if (!pending || (properties.sessionID && properties.sessionID !== pending.sessionId)) return;
    // Our own reply's echo looks the same as another client's answer, so while
    // it is in flight only remember the event; the reply's outcome decides.
    if (sending.has(requestId)) {
      supersededWhileSending.add(requestId);
      return;
    }
    byNativeId.delete(requestId);
    seenAt.delete(requestId);
    approvals.withdraw(pending.approvalId, 'OpenCode permission was resolved elsewhere');
  }

  /** The point a pending snapshot is requested at; pass it back to reconcile. */
  function mark() {
    return sequence;
  }

  /**
   * Withdraw this session's requests that a pending snapshot no longer lists.
   * Only an array is evidence: any other body proves nothing and withdraws
   * nothing. Only requests seen at or before `asOf` are judged, including one
   * still being opened into the inbox, which is tombstoned so it is withdrawn
   * the moment it lands.
   */
  function reconcile(sessionId, requests, asOf = sequence) {
    if (!Array.isArray(requests)) return;
    const pending = new Set(requests.map((request) => request?.id));
    const judged = (requestId) => (seenAt.get(requestId) ?? Infinity) <= asOf;
    for (const [requestId, owner] of byNativeId) {
      if (owner.sessionId !== sessionId || pending.has(requestId) || !judged(requestId)) continue;
      byNativeId.delete(requestId);
      seenAt.delete(requestId);
      approvals.withdraw(owner.approvalId, 'OpenCode permission request is no longer pending');
    }
    for (const [requestId, owningSession] of openingIds) {
      if (owningSession !== sessionId || pending.has(requestId) || !judged(requestId)) continue;
      resolvedDuringOpen.add(requestId);
    }
  }

  return {
    asked,
    replied,
    reconcile,
    mark,
    registerVoiceTurn(sessionId, context) {
      if (!approvals?.authorize) return () => {};
      const controller = new AbortController();
      const voice = {
        ...context,
        signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal,
        seen: new Set(),
      };
      voiceTurns.set(sessionId, voice);
      return () => {
        if (voiceTurns.get(sessionId) === voice) voiceTurns.delete(sessionId);
        controller.abort();
      };
    },
    /**
     * Follow every card's lifetime. The listener gets `{ phase, sessionId,
     * requestId }` with phase `open` once the inbox accepts a decision and
     * `settle` once it no longer does; the returned function stops the watch.
     * A turn uses this to treat an open card like a running tool.
     */
    watch(watcher) {
      if (typeof watcher !== 'function') return () => {};
      watchers.add(watcher);
      return () => { watchers.delete(watcher); };
    },
    watchApproval(watcher) {
      approvalWatchers.add(watcher);
      return () => { approvalWatchers.delete(watcher); };
    },
    setReplyApproval(handler) { sendReply = handler; },
  };
}
