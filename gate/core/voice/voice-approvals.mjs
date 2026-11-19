import { redactSensitiveText } from '../credentials/redaction.mjs';

// The inbox, banner and voice announcement must agree on the safe summary.
// Reject before redacting as well: a shortened description is not consent to
// parts of a request that the operator was never shown.
export function voiceApprovalSummary(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || Buffer.byteLength(raw) > 240) return null;
  const safe = redactSensitiveText(raw).replace(/\s+/gu, ' ');
  return Buffer.byteLength(safe) <= 240 ? safe : null;
}

// A native prompt already parked upstream. Deliver it through the same
// permission layer.
export function mirrorVoiceApprovals({ approvals, deviceId, backendId, botId, sessionId, onApproval, signal, timeoutMs }) {
  const seen = new Set();
  const controller = new AbortController();
  const close = () => {
    signal?.removeEventListener('abort', close);
    controller.abort();
  };
  if (signal?.aborted) close();
  else signal?.addEventListener('abort', close, { once: true });

  async function open(request) {
    if (typeof request?.reply !== 'function') {
      if (!controller.signal.aborted) onApproval?.(request);
      return;
    }
    if (request.key !== undefined) {
      if (seen.has(request.key)) return;
      seen.add(request.key);
    }
    const summary = voiceApprovalSummary(request.summary);
    if (!approvals?.authorize || !deviceId || controller.signal.aborted) {
      await request.reply(false);
      return;
    }

    const allowed = await approvals.authorize({
      tool: request.tool, deviceId, backendId, botId, sessionId, timeoutMs, signal: controller.signal,
      // Legacy native cards expose a redacted summary. It is never persisted;
      // the ledger uses the fixed tool/class summary in all cases.
      legacySummary: summary ?? undefined, announce: onApproval, requireDecision: true,
    }).catch(() => false);
    await request.reply(allowed && !controller.signal.aborted);
  }

  return { open: (request) => { void open(request).catch(() => undefined); }, close };
}
