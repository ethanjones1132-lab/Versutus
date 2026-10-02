/**
 * Upstream failure wearing a normal reply.
 *
 * Hermes returns a turn that failed upstream as a NORMAL completion whose
 * whole assistant text is the error, e.g.
 * `HTTP 400: omen-alpha is not a valid model ID` (reproduced 2026-09-16 via
 * POST /v1/chat/completions with bot=default) — and, when the failure was a
 * custom endpoint that never answered, that same status inside a sentence the
 * gateway wrote around it (`... Provider said: HTTP 404: ...`). Delivered as-is,
 * the app renders that as the Bot speaking the error, the non-streaming route
 * answers 200 with `finish_reason: stop`, and the model-health table records a
 * success for exactly the model that cannot answer.
 *
 * Only a message that IS this shape is a refusal. A real reply that merely
 * MENTIONS "HTTP 400" inside prose is a reply and is never rewritten — so the
 * status line has to be the claim. What it may be introduced by is narrow: a
 * lead-in that reports what a named upstream said, which is the same wording
 * core/model-fault.mjs already treats as evidence the provider produced it.
 */
const UPSTREAM_REFUSAL = /^(?:[\s\S]*\b(?:provider|upstream|endpoint|server|api)\s+(?:said|reported|returned|responded|answered)\b[:\s]*)?HTTP \d{3}: .+$/i;

export function backendUpstreamRefusal(text) {
  const trimmed = String(text ?? '').trim();
  return UPSTREAM_REFUSAL.test(trimmed) ? trimmed : null;
}
