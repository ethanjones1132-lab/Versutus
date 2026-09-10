// ─── The composer's mic control ───────────────────────────────────────────
// Solution B's push-to-talk is one control in the composer, beside send
// (FUTURE-ITEMS.md §B1 `:429`), and it may not be drawn where it cannot
// finish. B3 asks for the unusable-while-disconnected state to stay explicit,
// because the composer already knows the connection (`:449-452`).
//
// This is the one fold that answers what that control is: nothing at all on a
// build with no recognizer, a disabled mic carrying one reason line while the
// gateway is away, and a live mic otherwise. The composer draws whatever this
// answers and authors no state of its own, so the control and the reason
// cannot disagree.
//
// The module reaches nothing. The hold's own conversation with the phone is
// the seam in `speech-recognition.ts`; what a hold DOES is the composer's two
// edges over that seam, and this file only says when the control is there.

import type { ConnectionStatus } from '@/lib/gateway/types';

/**
 * The one line the mic wears instead of going live while the gateway is away.
 * A hold's whole outcome is a draft for a conversation with a gateway, so the
 * control is stated as waiting for the connection rather than drawing a live
 * mic whose words have nowhere to go. No figure, no fake result count: the
 * gateway is away, not broken.
 */
export const MIC_DISCONNECTED_COPY = 'Connect a gateway to talk with your voice.';

/**
 * What the composer draws where the mic sits:
 * - `hidden` — this build carries no recognizer (or cannot answer whether it
 *   does). No control and no reason: nothing to say about a mic that is not
 *   there.
 * - `disabled` — the phone can hear, but the gateway this draft is for is not
 *   connected. Drawn, dimmed, unpressable, with the module's own reason line.
 * - `live` — drawn and held to talk.
 */
export type MicControlState =
  | { kind: 'hidden' }
  | { kind: 'disabled'; reason: string }
  | { kind: 'live' };

export type MicControlInput = {
  /** Whether this build's recognizer answered available. */
  available: boolean;
  /** The live connection to the gateway this conversation is on. */
  status: ConnectionStatus;
  /**
   * Whether a reply is streaming. Taken, and deliberately not a reason to
   * hide or disable: the send control beside it stays pressable while a reply
   * is in flight (it becomes Stop), so a reply arriving must not be the thing
   * that takes the mic away. A hold that ends mid-reply leaves its words in
   * the draft for the operator to send when the reply is done.
   */
  isStreaming: boolean;
};

/**
 * The one answer the composer's mic control is drawn from. Availability first
 * — a build that cannot hear is offered nothing in any connection state — and
 * then the connection: only `connected` is live, so connecting, reconnecting
 * and pairing all wait rather than half-working while the connection settles.
 * Streaming is not one of this control's states (see `MicControlInput`), so
 * the gateway's answer is the whole rule.
 */
export function micControlState(input: MicControlInput): MicControlState {
  if (!input.available) return { kind: 'hidden' };
  if (input.status !== 'connected') return { kind: 'disabled', reason: MIC_DISCONNECTED_COPY };
  return { kind: 'live' };
}
