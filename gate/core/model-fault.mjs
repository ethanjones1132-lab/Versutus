/**
 * Is a failed turn evidence about the MODEL?
 *
 * The model-health table hides a model for six hours after two failed turns
 * (core/model-health.mjs), so what a failure counts as decides whether the
 * operator's models are in the picker at all. On 2026-10-02 a defect in this
 * Gate — `call()` reading OpenCode's empty 204 with `response.json()` — made
 * every turn in every OpenCode thread answer `Unexpected end of JSON input`,
 * and two of those verdicts hid `opencode-go/longcat-2.5-preview-free` and
 * `opencode/fledge-alpha-free` for the day. A transport that broke, a body that
 * failed to parse and a process that would not start are facts about the Gate,
 * not about a model, and none of them is anything the operator can act on by
 * picking a different model.
 *
 * So the rule is one-sided: a failure counts against a model only when the model
 * or the provider behind it produced it. Everything else — a Gate-side fault,
 * a reason nobody recognises — counts for nothing at all. It is not turned into
 * a success either: a turn the Gate broke is not evidence the model works.
 */

/**
 * The Gate's own fault classes. These are bugs in this process (a bad parse, a
 * call of something that is not a function) and never anything a provider said,
 * whatever the message happens to contain.
 */
const GATE_ERROR_TYPES = new Set(['SyntaxError', 'TypeError', 'ReferenceError', 'RangeError']);

/**
 * The Gate's own signatures, as text.
 *
 * A stored reason in model-health.json is the only thing left of a fault after a
 * restart, so these are matched against the reason as well (see
 * `isGateInternalReason`): the verdicts this Gate wrote against itself have to
 * heal without anyone editing the file by hand.
 */
const GATE_FAULTS = [
  // A body that was not the JSON it claimed to be — the 204 defect, and any
  // other unreadable answer read with `response.json()`.
  /unexpected (?:end of (?:json )?input|token)/i,
  /is not a function/i,
  /cannot read (?:property|properties)/i,
  // Transport: the server could not be reached at all.
  /could not reach\b/i,
  /\bfetch failed\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/,
  /\bUND_ERR_[A-Z0-9_]+\b/,
  // The environment's own server: a process that would not come up is the
  // Gate's environment failing, not a model refusing.
  /did not become reachable\b/i,
  /exited with (?:code|status)\b/i,
  // No attached backend could serve the method at all (core/backend-resolution).
  /\bbackend_unavailable\b/,
];

/**
 * What a failure has to look like before it is held against a model: evidence
 * the provider or the model produced it.
 *
 * The HTTP patterns are the shapes these reasons actually take on this host —
 * `HTTP 404: ...` (also the shape `backendUpstreamRefusal` recognises),
 * `statusCode: 404`, and `hermes: 502 upstream is unavailable` — deliberately
 * narrow rather than "any three digits from 4 to 5", because a number that
 * happens to look like a status is not evidence of anything.
 */
const MODEL_FAULTS = [
  /\bhttp[\s/:]*status\b[\s:=]*[45]\d{2}\b/i,
  /\bhttp[\s/:]+[45]\d{2}\b/i,
  /\bstatus ?code\b\s*[:=]?\s*[45]\d{2}\b/i,
  /\b[45]\d{2}\b[^.\n]{0,24}\b(?:unavailable|refused|forbidden|not found|too many requests|error)\b/i,
  /\b429\b/,
  /\brate[- ]?limit(?:ed|ing|s)?\b/i,
  /\bquota\b/i,
  /\bnot a valid model\b/i,
  /\bmodel_not_available\b/i,
  // opencode-go answers `400 MissingSessionID` for every one of its 42 models
  // when the header is absent: that IS the provider refusing the model's route.
  // A Hermes `session not found` is deliberately NOT here: it is a lookup of the
  // Gate's own session (the thread-tap bug of 2026-10-02 was exactly that), so
  // it says nothing about the model and must never hide one.
  /\bmissingsessionid\b/i,
  /\bno endpoints available\b/i,
  // OpenCode's own account of what the provider said while failing over.
  /\bprovider said\b/i,
  // The silence bound: the model accepted a turn and then never answered.
  /\bdid not answer within\b/i,
  // The turn completed and said nothing (the app's `empty_turn`).
  /the backend completed the turn with no assistant content/i,
];

/**
 * A code the runtime itself uses (Node, undici, a system call). Whoever asked,
 * it says the transport failed.
 */
const SYSTEM_CODE = /^(?:E[A-Z]{2,}|ERR_[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/;

/**
 * Whether a failed turn says anything about the model behind it.
 *
 * @param {unknown} error What the turn threw: an Error, or a reason string.
 * @returns {boolean} True only for a refusal, a quota, a rate limit, an unknown
 *   model, an upstream status error or a turn that answered nothing. False for
 *   the Gate's own faults and for anything unrecognised.
 */
export function isModelFault(error) {
  if (!error) return false;
  // A Gate-side throw is a Gate-side fault whatever its message reads like: the
  // refusal is not the provider's if the Gate is the one that failed to parse it.
  if (GATE_ERROR_TYPES.has(error.name)) return false;
  const text = errorText(error);
  if (isGateInternalReason(text)) return false;
  if (SYSTEM_CODE.test(String(error.code ?? ''))) return false;
  return MODEL_FAULTS.some((pattern) => pattern.test(text));
}

/**
 * Whether a stored reason is one of the Gate's own fault signatures.
 *
 * model-health.json keeps reasons, not errors, so this is how a verdict the Gate
 * wrote against itself is recognised again on the next start: it is dropped on
 * load rather than waiting out the rest of its six hours.
 */
export function isGateInternalReason(value) {
  const text = typeof value === 'string' ? value : String(value?.message ?? '');
  if (!text) return false;
  return GATE_FAULTS.some((pattern) => pattern.test(text));
}

/** The text of a throw, however it arrived: an Error, a plain object or a string. */
function errorText(error) {
  if (typeof error === 'string') return error;
  const message = error?.message;
  return typeof message === 'string' ? message : '';
}
