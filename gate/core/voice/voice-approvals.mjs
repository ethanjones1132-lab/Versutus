// A backend's native prompt has already parked the tool. Mirror it into the
// existing approval RPC, with a Gate-owned deadline independent of the phone.
// This is delivery/settlement, not a policy for tools that never ask upstream.
export function mirrorVoiceApprovals({ approvals, deviceId, onApproval, signal, timeoutMs = 30_000 }) {
  const seen = new Set();
  const pending = new Set();
  let closed = false;
  const close = () => {
    closed = true;
    signal?.removeEventListener('abort', close);
    for (const expire of pending) expire();
  };
  signal?.addEventListener('abort', close, { once: true });

  async function open(request) {
    if (typeof request?.reply !== 'function') {
      if (!closed) onApproval?.(request);
      return;
    }
    if (seen.has(request.key)) return;
    seen.add(request.key);
    const summary = typeof request.summary === 'string' ? request.summary.trim() : '';
    // Don't offer Approve for an action whose full description won't fit.
    if (!approvals || !deviceId || closed || signal?.aborted || !summary || Buffer.byteLength(summary) > 240) {
      await request.reply(false);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    let timer;
    let entry;
    const announce = (state) => {
      if (!closed) onApproval?.({ approvalId: entry.approvalId, summary, state });
    };
    const release = () => {
      clearTimeout(timer);
      pending.delete(expire);
    };
    const expire = () => {
      release();
      // A tap already being sent before the deadline is a real decision.
      if (!approvals.get(entry.approvalId) || entry.deciding) return;
      approvals.withdraw(entry.approvalId, 'Voice approval expired');
      announce('expired');
      void request.reply(false).catch(() => undefined);
    };
    entry = await approvals.normalize({
      type: 'workspace_write',
      voiceDeviceId: deviceId,
      summary,
      async replyVoiceApproval(approved) {
        if (closed || signal?.aborted || Date.now() >= deadline) {
          // Release the inbox entry and refuse this tap even if the event loop
          // hasn't yet run the deadline timer.
          approvals.withdraw(entry.approvalId, 'Voice approval expired');
          release();
          announce('expired');
          await request.reply(false);
          const error = new Error('Voice approval expired');
          error.code = 'unknown_approval';
          error.status = 404;
          throw error;
        }
        try {
          await request.reply(approved);
          release();
          announce(approved ? 'approved' : 'denied');
        } catch (error) {
          // An upstream refusal is retryable only while the prompt is live.
          if (closed || Date.now() >= deadline) {
            approvals.withdraw(entry.approvalId, 'Voice approval expired');
            release();
            announce('expired');
            void request.reply(false).catch(() => undefined);
          }
          throw error;
        }
      },
    });
    if (closed || signal?.aborted) {
      expire();
      return;
    }
    pending.add(expire);
    timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    timer.unref?.();
    announce('pending');
  }

  return { open: (request) => { void open(request).catch(() => undefined); }, close };
}
