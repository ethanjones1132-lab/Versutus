/**
 * Upstream failure wearing a normal reply.
 *
 * Hermes returns a turn that failed upstream as a NORMAL completion whose
 * whole assistant text is the error, e.g.
 * `HTTP 400: omen-alpha is not a valid model ID` (reproduced 2026-09-16 via
 * POST /v1/chat/completions with bot=default). Delivered as-is, the app
 * renders that as the Bot speaking the error. Only a message that IS this
 * shape is a refusal — a real reply that merely MENTIONS "HTTP 400" inside
 * prose is a reply and is never rewritten.
 */
export function backendUpstreamRefusal(text) {
  const trimmed = String(text ?? '').trim();
  return /^HTTP \d{3}: .+$/i.test(trimmed) ? trimmed : null;
}
