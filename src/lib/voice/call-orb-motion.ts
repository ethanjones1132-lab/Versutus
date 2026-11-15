// ─── What the call's light is doing, as plain numbers ─────────────────────
// The orb beside the call's status has one job: say at a glance whether the
// call is getting ready, can hear you, is working on an answer, or is talking.
// Everything it draws comes from the two functions here, so the choice of
// state and the response to a voice are pinned by tests that mount nothing.

import type { HandsfreePhase } from '@/lib/voice/handsfree-session';

/** The five things a call can be doing that look different. */
export type CallOrbMode = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted';

/**
 * Which of them a phase is. Mute wins over everything: the microphone being
 * off is the one fact the operator must never have to read twice. The
 * confirming grace window is still listening, and both halves of a turn in
 * flight (sent, waiting for the reply) are the same wait to look at.
 */
export function callOrbMode(phase: HandsfreePhase, muted: boolean): CallOrbMode {
  if (muted || phase === 'muted') return 'muted';
  switch (phase) {
    case 'listening':
    case 'confirming':
      return 'listening';
    case 'sending':
    case 'waiting':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      return 'connecting';
  }
}

/** The quietest level that moves the orb at all, and the level that fills it. */
export const CALL_ORB_FLOOR_DB = -52;
export const CALL_ORB_CEILING_DB = -14;

/**
 * A microphone level as how much the orb should swell, 0–1.
 *
 * The level is a linear RMS of the captured frame, and speech at arm's length
 * sits around 0.02–0.1 of full scale. Drawn linearly — as the first indicator
 * did — that is a change of a pixel or two, which is why it looked like an
 * animation that never played. Loudness is heard in decibels, so it is drawn in
 * them: the room's hush is nothing, ordinary speech is most of the way, and a
 * raised voice fills it.
 *
 * A worklet: it runs on the UI thread for every sample, and no React render
 * happens for any of them.
 */
export function callOrbGain(level: number): number {
  'worklet';
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  const gain = (db - CALL_ORB_FLOOR_DB) / (CALL_ORB_CEILING_DB - CALL_ORB_FLOOR_DB);
  return Math.max(0, Math.min(1, gain));
}
