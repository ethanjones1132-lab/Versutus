// ─── Proving a Gate media link is actually up ──────────────────────────────
// `startGateMedia` resolves as soon as the native side has handed the socket to
// OkHttp and capture/playback are open; it has no `onOpen` to report, so its
// boolean means "the request was issued", never "the Gate is listening". Every
// failure therefore arrives later, as a `socket_failed`/`socket_closed` frame.
// Two consumers used to read that boolean as a live link, so a dead audio path
// was invisible: the start reported success and the banner sat on "Listening"
// for minutes with nothing heard, nothing sent and no end reason.
//
// The only evidence the link is real is the Gate's own first frame on that
// socket (`ready`/`phase` on attach, or `level`/`partial` once it hears). This
// is that wait, and nothing else claims to know the link is up.

import { parseGateFrame, type GateVoiceFrame } from './voice-stream-protocol';

/**
 * How long a media link may take to speak. Long enough for a phone waking its
 * radio and a Gate loading a model on the other end, short enough that a link
 * that never comes up fails the start instead of parking the sheet on
 * "Starting".
 */
export const GATE_LINK_READY_MS = 10_000;

/**
 * What became of a link: the Gate spoke, the socket died before it could, or
 * nothing came either way. Never `true` — the boolean that opened the socket is
 * not evidence, so this is the only answer a caller may act on.
 */
export type GateLinkProof = 'frame' | 'failed' | 'timeout';

/** The frame, or null when the Gate sent something this build cannot read. */
export function parseGateFrameOrNull(frame: string): GateVoiceFrame | null {
  try {
    return parseGateFrame(frame);
  } catch {
    return null;
  }
}

/**
 * True for the two frames the native side emits when the audio link itself is
 * gone — `socket_failed` (OkHttp's failure) and `socket_closed` (the Gate
 * closed it without an `ended` frame). Before a link is proven these are a
 * failure, not a frame that proves one.
 */
export function isGateSocketGone(frame: string): boolean {
  const parsed = parseGateFrameOrNull(frame);
  return (
    parsed?.t === 'error' &&
    parsed.fatal &&
    (parsed.code === 'socket_failed' || parsed.code === 'socket_closed')
  );
}

export type GateLinkProbe = {
  /**
   * Mark that a link is about to be opened, so its first frame is kept even
   * while the caller is still between `startGateMedia` and `prove`. The socket
   * can answer its attach faster than JS can arm the proof — the first call
   * after a permission dialog, when the JS thread is busy resuming, is exactly
   * when it does — and a frame that arrived in that gap used to be dropped,
   * leaving a live link to time out as if the Gate had never spoken.
   */
  arm: () => void;
  /** Wait for the Gate's first frame on this link, its death, or the budget. */
  prove: (budgetMs?: number) => Promise<GateLinkProof>;
  /** Hand every arriving frame to the probe. Settles a pending proof. */
  observe: (frame: string) => void;
  /** Forget a proof whose start has ended, so a late frame settles nothing. */
  release: () => void;
};

/**
 * One proof at a time, held outside React: this is read and written from socket
 * callbacks and awaited by the start chain, and a state write per frame would
 * redraw the banner for each one.
 *
 * `observe` treats any frame — even one this build cannot parse — as proof,
 * because something answered on the wire. Only the socket-gone frames are a
 * failure; everything else is the link talking.
 */
export function createGateLinkProbe(): GateLinkProbe {
  let settle: ((proof: GateLinkProof) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // A frame that arrived after `arm` but before `prove`. It belongs to the link
  // being opened, so the proof that follows it may use it; frames observed
  // outside an armed link are late news about a link that is gone.
  let latched: GateLinkProof | null = null;
  let armed = false;

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    settle = null;
    latched = null;
    armed = false;
  };

  return {
    arm(): void {
      clear();
      armed = true;
    },
    prove(budgetMs: number = GATE_LINK_READY_MS): Promise<GateLinkProof> {
      // A re-opened link supersedes the proof before it: the socket that never
      // spoke is not the socket being waited on now. A frame this link already
      // sent while it was being opened is not superseded: it is the proof.
      const early = latched;
      clear();
      if (early) return Promise.resolve(early);
      return new Promise<GateLinkProof>((resolve) => {
        const finish = (proof: GateLinkProof): void => {
          clear();
          resolve(proof);
        };
        armed = true;
        settle = finish;
        timer = setTimeout(() => finish('timeout'), budgetMs);
      });
    },
    observe(frame: string): void {
      const proof: GateLinkProof = isGateSocketGone(frame) ? 'failed' : 'frame';
      if (settle) {
        settle(proof);
        return;
      }
      if (armed) latched = proof;
    },
    release(): void {
      clear();
    },
  };
}
