// ─── What a call lets you feel instead of hear ───────────────────────────
// A call is a conversation: every sound the app adds to it lands on top of
// someone's words. The send beep played at the end of each thing the operator
// said, at notification volume, through the same speaker the reply was about to
// use — the one moment a call should be quiet. So the two moments worth marking
// are marked in the hand, not the ear, and the screen says the rest.
//
// Both are the lightest ticks the platform has, they never queue or repeat, and
// a phone that cannot vibrate (or has haptics off) simply stays still: the
// orb and the state beside it carry the same news.

import { haptics } from '@/lib/haptics';

export const callCues = {
  /** The call can hear you now. Once per call, when listening first opens. */
  ready: () => haptics.light(),
  /** What you said has been taken and sent; an answer is on its way. */
  sent: () => haptics.selection(),
};
