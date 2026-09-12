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

import type { HandsfreePhase } from '@/lib/voice/handsfree-session';

/** The exact disclosure the sheet shows before the first call, and every one. */
export const HANDSFREE_DISCLOSURE =
  'Hands-free calls listen only after you start them. Speech is sent automatically when you pause. You can interrupt a reply just by talking. The call continues while Versutus is in the background. End it here or from Android’s notification.';

/** The label beside the Call control. */
export const HANDSFREE_START_LABEL = 'Start hands-free call';
/** The banner's permanent auto-send reminder. */
export const HANDSFREE_BANNER_TITLE = 'Hands-free call';
/** The persistent half of the banner's title, spelling out the contract. */
export const HANDSFREE_AUTOSEND_LABEL = 'speech auto-sends';
/** Shown beside `Speaking` so barge-in is discoverable without sight. */
export const HANDSFREE_SPEAKING_HINT = 'say something to interrupt';

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
