// ─── The hands-free call's words ──────────────────────────────────────────
// The disclosure a call must show before it can start, the banner's labels and
// the accessibility phrases live here, apart from the components that draw
// them, so copy cannot drift between the sheet, the banner and the docs — and
// so the words are pinned by a test that does not mount a screen.
//
// The disclosure is deliberately specific: speech leaves automatically once a
// call starts, the call survives backgrounding, and it can be ended from the
// Android notification. It must never read as always-listening or as a
// wake-word feature, which B5 forbids.

import { DEVICE_IDENTITY_FAILURE } from '@/lib/gateway/errors';
import type { HandsfreePhase, HandsfreeTerminalReason } from '@/lib/voice/handsfree-session';
import type {
  HandsfreeStartCopyContext,
  HandsfreeStartFailure,
} from '@/lib/voice/handsfree-start-reason';

/** The exact disclosure the sheet shows before the first call, and every one. */
export const HANDSFREE_DISCLOSURE =
  'Hands-free calls listen only after you start them. Speech is sent automatically when you pause. You can interrupt a reply just by talking. The call continues while Versutus is in the background. End it here or from Android’s notification.';

/**
 * The one sentence that says where a dead call's words go. Crash recovery is
 * shipped (`promoteHandsfreeRecovery`): the newest persisted transcript is
 * joined onto the composer draft when a call dies mid-turn, so the words can
 * surface in the composer without anyone speaking them again — the operator
 * is owed that fact up front, in the disclosure, not on launch.
 */
export const HANDSFREE_RECOVERY_DISCLOSURE =
  'If the call is interrupted unexpectedly, what you said can appear in the message box — review it before sending, as always.';

/** The label beside the Call control. */
export const HANDSFREE_START_LABEL = 'Start hands-free call';
/** The banner's permanent auto-send reminder. */
export const HANDSFREE_BANNER_TITLE = 'Hands-free call';
/** The persistent half of the banner's title, spelling out the contract. */
export const HANDSFREE_AUTOSEND_LABEL = 'speech auto-sends';
/** Shown beside `Speaking` so barge-in is discoverable without sight. */
export const HANDSFREE_SPEAKING_HINT = 'say something to interrupt';
/** Shown beside `Listening` during the confirming grace window, so a speech
 * pause with the turn already heard does not read as a dead recognizer. */
export const HANDSFREE_CONFIRMING_HINT = 'finishing…';

/**
 * How long the call has been running, folded from the epoch the session
 * recorded when it started. Null when the start time is unknown: a call
 * whose start this device never recorded must not be shown a zero
 * duration — silence is more honest than a lie about time.
 */
export function handsfreeElapsedCopy(startedAtMs: number | undefined, nowMs: number): string | null {
  if (startedAtMs === undefined) return null;
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0 ? `running ${hours}h ${minutes}m` : `running ${minutes}m`;
}

export const HANDSFREE_MUTE_LABEL = 'Mute hands-free call';
export const HANDSFREE_UNMUTE_LABEL = 'Unmute hands-free call';
export const HANDSFREE_SKIP_LABEL = 'Skip spoken reply';
export const HANDSFREE_END_LABEL = 'End hands-free call';

/** The composer mic's reason while a call already owns the microphone. */
export const HANDSFREE_MIC_LOCK_COPY = 'A hands-free call is using the microphone.';

/**
 * The banner's phase label. The internal `confirming` grace window is folded
 * into `Listening` — it is an implementation detail, not a state the operator
 * needs a new word for.
 */
export function handsfreePhaseLabel(phase: HandsfreePhase): string {
  switch (phase) {
    case 'listening':
    case 'confirming':
      return 'Listening';
    case 'sending':
      return 'Sending';
    case 'waiting':
      return 'Waiting for reply';
    case 'speaking':
      return 'Speaking';
    case 'muted':
      return 'Muted';
    case 'starting':
      return 'Starting';
    case 'ending':
      return 'Ending';
    default:
      return '';
  }
}

/** Why a call the operator did not end, ended. Null when they ended it or moved on. */
export function handsfreeEndReasonCopy(reason: HandsfreeTerminalReason): string | null {
  switch (reason) {
    case 'user':
    case 'thread-changed':
      return null;
    case 'disconnect':
      return 'The call ended because the gateway connection dropped.';
    case 'system-interruption':
      return 'The call ended because another app or a phone call took the audio.';
    case 'app-killed':
      return 'The call ended when Versutus was closed.';
    case 'recognition-failed':
      return 'The call ended because speech recognition stopped working on this phone.';
    case 'send-failed':
      return 'The call ended because a turn could not be sent or no reply arrived. What you said is back in the composer.';
    case 'speech-failed':
      return 'The call ended because this phone could not speak the reply.';
  }
}

function withDetail(base: string, detail: string | undefined): string {
  if (!detail) return base;
  const trimmed = detail.trim();
  if (!trimmed || base.includes(trimmed)) return base;
  return `${base} ${trimmed}`;
}

/** Why a start did not open a call. Named per exit, and never blames this phone's recognizer for a PC-engine failure. */
export function handsfreeStartResultCopy(
  result: HandsfreeStartFailure,
  context: HandsfreeStartCopyContext = {},
): string {
  const detail = context.detail;
  switch (result) {
    case 'permission-denied':
      return 'Versutus needs the microphone for a call. Allow it in Settings, then start again.';
    case 'identity-unavailable':
      return DEVICE_IDENTITY_FAILURE;
    case 'refused':
      return 'A call cannot start right now. Reconnect the chat and try again.';
    case 'no-native-module':
      return 'This build of Versutus cannot open a call on this phone.';
    case 'availability-unreadable':
      return 'This phone would not say whether it can take a call. Try again.';
    case 'phone-recognition-unavailable':
      return 'This phone would not open a call session. Try again; if it keeps failing, check that a speech recognition service is installed and enabled.';
    case 'phone-synthesis-unavailable':
      return 'This phone cannot speak a reply. Check that a text-to-speech engine is installed and enabled.';
    case 'no-gateway-url':
      return 'Versutus does not have this PC’s address, so it cannot start a call on the host.';
    case 'device-params-failed':
      return 'This phone could not name itself to the PC. Try reconnecting, then start again.';
    case 'no-session':
      return 'This thread does not have a chat session yet. Send a message first, then start the call.';
    case 'not-paired':
      return 'This phone is not paired with the PC, so the PC will not open a call. Reconnect and approve it, then start again.';
    case 'call-in-progress':
      return 'The PC still has a live call for this phone. End it, wait a moment, then start again.';
    case 'no-engine':
      return withDetail(
        'The PC voice engine is not ready. Check Voice in Settings, or run voice install on the PC.',
        detail,
      );
    case 'session-start-failed':
      return withDetail('The PC would not open the call.', detail);
    case 'session-grant-incomplete':
      return 'The PC opened a call without a media path, so this phone could not join it.';
    case 'media-start-failed':
      return 'This phone could not open the audio link to the PC. Stay on the same network and try again.';
    case 'call-torn-down-while-starting':
      return 'The call ended before it finished opening. The connection dropped or the thread changed.';
    case 'native-session-unavailable':
      return 'This phone would not open its call session. Try again.';
    case 'unavailable':
      return context.transport === 'gate' || context.engine === 'local' || context.engine === 'codex'
        ? 'The PC-powered call could not start. Try again; if it keeps failing, check that Versutus on the PC is running.'
        : 'The call could not start. Try again.';
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
