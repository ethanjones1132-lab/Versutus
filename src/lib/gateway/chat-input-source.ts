// ─── Where one chat send came from ────────────────────────────────────────
// A composer send and a hands-free call send travel the same text contract but
// are governed differently, and that difference lives here rather than inside
// the provider:
//
//   - A composer send that cannot reach the gateway is parked in the durable
//     offline outbox and flushed when the connection returns.
//   - A call send that cannot reach the gateway belongs to the recovery layer,
//     never the outbox: a call is a live conversation, and queuing speech for
//     later automatic delivery is exactly the behavior B5 forbids.
//   - A call transcript is plain model text even if the recognizer heard a
//     leading slash; auto-sent speech must never dispatch a command.
//   - A call send attempted while a send/stream is already in flight is `busy`
//     rather than a hollow `sent`: `sendMessage` would early-return and the
//     caller would wait a reply watchdog for a message that never left.
//
// Pure and total, so the policy is testable without mounting the provider.

/** Which surface handed text to the send path. */
export type ChatInputSource = 'composer' | 'handsfree-call';

/** What a call send should do before any text leaves. */
export type CallSendDecision = 'send' | 'offline' | 'busy';

/**
 * Whether a source is the hands-free call's auto-send. Omitted means the
 * composer, so every existing caller keeps today's behavior exactly.
 */
export function isHandsfreeCallSource(source: ChatInputSource | undefined): boolean {
  return source === 'handsfree-call';
}

/**
 * Whether text from this source is plain model text. A call transcript is
 * always plain text: recognition never produces a command, and a leading slash
 * on auto-sent speech is just a slash.
 */
export function routesAsModelText(source: ChatInputSource | undefined): boolean {
  return isHandsfreeCallSource(source);
}

/**
 * The gate a call send passes before it is handed to `sendMessage`. A composer
 * send is never gated here — this answers only for `handsfree-call`, and
 * `send` for every other source so the caller's existing branch still runs.
 *
 * `offline` is checked before `busy`: a call that cannot reach its gateway is
 * offline whether or not a send was in flight, and the recovery layer's answer
 * does not change because the connection also happened to be busy.
 */
export function decideCallSend(input: {
  source: ChatInputSource | undefined;
  /** The captured gateway/session is still connected and current. */
  connected: boolean;
  /** A send or stream is already in flight. */
  busy: boolean;
}): CallSendDecision {
  if (!isHandsfreeCallSource(input.source)) return 'send';
  if (!input.connected) return 'offline';
  if (input.busy) return 'busy';
  return 'send';
}
