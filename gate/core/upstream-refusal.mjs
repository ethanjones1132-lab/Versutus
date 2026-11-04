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
 * status line has to be the claim, and the claim has to start the message.
 * What may stand in front of the status is narrow: the status itself at
 * position 0, or a lead-in that reports what a named upstream said — the same
 * wording core/model-fault.mjs already treats as evidence the provider
 * produced it — with the status behind it an error code (4xx/5xx), plus the
 * one sentence the gateway writes around a custom endpoint that never
 * answered. That lead-in phrase was not enough on its own: with an optional
 * `[\s\S]*` in front of it, the last clause of a real answer — "The endpoint
 * returned HTTP 200: OK" inside "I called the endpoint twice. The endpoint
 * returned HTTP 200: OK on the first try." — was read as the claim (VS-004,
 * quality scan 2026-11-04), so an ordinary reported success was rewritten as
 * a failed turn. Anchor the forms at the start and let reported successes
 * through: a wrapper texts an error, not a 2xx.
 */
const UPSTREAM_REFUSAL =
  /^(?:HTTP \d{3}: .+|(?:Custom endpoint didn['’]t answer after \d+ attempts\. )?(?:The )?(?:provider|upstream|endpoint|server|api)\s+(?:said|reported|returned|responded|answered)[:\s]*HTTP [45]\d{2}: .+)$/i;

export function backendUpstreamRefusal(text) {
  const trimmed = String(text ?? '').trim();
  return UPSTREAM_REFUSAL.test(trimmed) ? trimmed : null;
}
