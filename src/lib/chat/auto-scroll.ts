// ─── Transcript auto-scroll coalescing ─────────────────────────────
// The transcript follows a live reply by asking the list to scroll to its end
// whenever the content grows. A streaming reply flushes several times inside
// one animation frame, and starting `scrollToEnd` once per flush — each glide
// restarted before the previous one settled — is what made a pinned transcript
// twitch. This reducer keeps the decision pure and caps the content-size path
// at one scroll request per frame: the first growth in a frame asks for the
// jump, later growth before the frame boundary only marks the transcript as
// still owing the bottom, and the boundary spends one further request. Growth
// is compared by the height the list reports, never by a row count or text.
//
// The caller owns `pinned` (the list's own scroll handler writes it, and a
// send, resume or pill tap pins it), so it is an input to each event rather
// than a second copy of that state kept here. The animation flag is an input
// too: a streaming turn jumps (`animated: false`) exactly as before, while a
// settled turn glides.

/** What the coalescer remembers between frames. */
export type AutoScrollState = {
  /** Content height at the last content-size event; null before the first. */
  contentHeight: number | null;
  /** This frame has already spent its one scroll request. */
  framePending: boolean;
  /** Growth arrived after that request: the frame boundary owes one scroll. */
  owed: { animated: boolean } | null;
};

/** Nothing requested yet; the first content-size event may follow. */
export const INITIAL_AUTO_SCROLL: AutoScrollState = {
  contentHeight: null,
  framePending: false,
  owed: null,
};

export type AutoScrollEvent =
  | {
      type: 'content-size';
      /** The height the list just reported. */
      contentHeight: number;
      /** The operator is at the bottom and the transcript may follow. */
      pinned: boolean;
      /** A streaming turn wants a jump; a settled one keeps its glide. */
      animated: boolean;
    }
  | { type: 'frame' };

export type AutoScrollStep = {
  state: AutoScrollState;
  /** Call `scrollToEnd` once with this; omitted when nothing should move. */
  scroll?: { animated: boolean };
};

/**
 * Advance the auto-scroll bookkeeping for one list event.
 *
 * A height that is not a finite number carries no geometry (a caller that did
 * not hand over the list's height), so growth cannot be ruled out and the
 * request is left exactly as it was before coalescing: follow it. Real list
 * events always report both dimensions, so this fallback is never taken by the
 * transcript itself.
 */
export function nextAutoScroll(state: AutoScrollState, event: AutoScrollEvent): AutoScrollStep {
  if (event.type === 'frame') {
    if (!state.framePending) return { state };
    if (!state.owed) return { state: { ...state, framePending: false, owed: null } };
    return {
      state: { ...state, framePending: true, owed: null },
      scroll: state.owed,
    };
  }

  const height = event.contentHeight;
  if (!Number.isFinite(height)) {
    return event.pinned ? { state, scroll: { animated: event.animated } } : { state };
  }

  const grew = state.contentHeight === null || height > state.contentHeight;
  if (!event.pinned || !grew) {
    return { state: { ...state, contentHeight: height } };
  }

  if (state.framePending) {
    return { state: { ...state, contentHeight: height, owed: { animated: event.animated } } };
  }

  return {
    state: { contentHeight: height, framePending: true, owed: null },
    scroll: { animated: event.animated },
  };
}
