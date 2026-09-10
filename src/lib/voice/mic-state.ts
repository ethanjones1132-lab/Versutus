// ─── The composer's mic control ───────────────────────────────────────────
// Solution B's push-to-talk is one control in the composer, beside send
// (FUTURE-ITEMS.md §B1 `:429`), and it may not be drawn where it cannot
// finish. B3 asks for the unusable-while-disconnected state to stay explicit,
// because the composer already knows the connection (`:449-452`).
//
// This is the one fold that answers what that control is: nothing at all on a
// build with no recognizer, a disabled mic carrying one reason line where the
// phone cannot be offered a hold at all, a disabled mic carrying its own reason
// line while the gateway is away, and a live mic otherwise. The composer draws
// whatever this answers and authors no state of its own, so the control and the
// reason cannot disagree.
//
// The module reaches nothing. The hold's own conversation with the phone is
// the seam in `speech-recognition.ts`; what a hold DOES is the composer's two
// edges over that seam, and this file only says when the control is there.

import type { ConnectionStatus } from '@/lib/gateway/types';

/**
 * The one line the mic wears when the PHONE cannot be offered a hold at all.
 * That is a refusal the platform will not re-ask — `canAskAgain` false, its own
 * "direct them to Settings" — so the line names the one thing the operator can
 * act on, the device's own settings, and counts nothing, like every other line
 * about this control. A phone that has never been asked or that the platform
 * will still ask is NOT this state: it is drawn live, so the hold raises the
 * platform's own dialog.
 *
 * It says voice input cannot START rather than that the last hold failed,
 * because the same line covers both ways this device reaches this reason: a
 * hold the platform refused, which started no session, and a read that found
 * the refusal already final, where no hold was attempted at all.
 */
export const MIC_PERMISSION_REFUSED_COPY =
  'The microphone is off for Versutus, so voice input cannot start — turn it on in Settings.';

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
 * - `disabled` — the control cannot finish, and the reason says which half is
 *   missing: this phone cannot be offered a hold, or the gateway this draft is
 *   for is not connected. Drawn, dimmed, unpressable, with that one line.
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
   * Whether a hold can be offered on this phone, read from the platform's own
   * record: the phone has already granted the microphone and speech
   * recognition, or the platform will still put its own dialog up. A phone the
   * platform will not re-ask is neither, so the refusal line is drawn exactly
   * where a hold could not start — never on a fresh install whose operator has
   * simply not been asked yet. The line for it is this module's, so a later
   * slice cannot re-word the refusal on a surface.
   */
  permissionAskable: boolean;
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
 * — a build that cannot hear is offered nothing in any connection state — then
 * the phone's own answer, then the connection: a phone a hold cannot be offered
 * on is refused in any connection state too, so the device's answer comes
 * before the gateway's rather than a live mic being drawn on a phone whose hold
 * would fail. Only `connected` is live, so connecting, reconnecting and pairing
 * all wait rather than half-working while the connection settles. Streaming is
 * not one of this control's states (see `MicControlInput`), so the two device
 * answers and the gateway's are the whole rule.
 */
export function micControlState(input: MicControlInput): MicControlState {
  if (!input.available) return { kind: 'hidden' };
  if (!input.permissionAskable) return { kind: 'disabled', reason: MIC_PERMISSION_REFUSED_COPY };
  if (input.status !== 'connected') return { kind: 'disabled', reason: MIC_DISCONNECTED_COPY };
  return { kind: 'live' };
}
