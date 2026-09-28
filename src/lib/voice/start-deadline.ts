// ─── Giving up on a start that never answers ──────────────────────────────
// A call opens through a chain of awaits — a grant RPC, a microphone
// permission, a media link. Each is a promise from somewhere this app does not
// control: the Gate's HTTP stack, a native module, the OS permission dialog.
// Any one of them can simply never settle, and the whole chain then never
// settles with it.
//
// That used to be unrecoverable. The call sits in `starting`, and `starting`
// only had three ways out: the native side confirming, the start being refused,
// or a terminal event. None of them can arrive if the await never returns, so
// the phase stayed `starting` for the life of the process — and because the
// Call control is offered only from `idle`, the user could not press it a second
// time. One abandoned first attempt ended hands-free for that app session.
//
// So the chain is bounded. This is deliberately the smallest thing that does
// that: a deadline the start sequence races each step against, and a named
// error so the failure is reported as its own reason rather than swallowed
// into the generic "unavailable" that once hid all of this.

/**
 * How long a start may take before it is abandoned. Long enough for a person
 * to answer a microphone prompt on a slow phone, short enough that a wedged
 * start is a recoverable annoyance rather than a dead feature.
 */
export const HANDSFREE_START_TIMEOUT_MS = 45_000;

/** The named reason a bounded wait gives up. Distinct from any real failure. */
export class HandsfreeStartTimeoutError extends Error {
  constructor(step: string) {
    super(`The call did not start: ${step} never answered.`);
    this.name = 'HandsfreeStartTimeoutError';
    this.step = step;
  }

  /** Which link in the chain went quiet, for the phone log. */
  readonly step: string;
}

/**
 * A one-shot budget for a start sequence. `guard` races a named link against
 * it — the name is what the timeout error carries, so a phone log says which
 * promise went quiet rather than only that some promise did — and `dispose`
 * must run once the sequence settles, whichever way.
 *
 * `guard` is also how a best-effort step is bounded: awaiting a compensating
 * `voice.session.stop` through it means a Gate that never answers the release
 * cannot strand the start either. Once the budget is spent the guard answers
 * immediately, so the step is still issued and its result is simply not waited
 * for.
 */
export function startDeadline(timeoutMs: number = HANDSFREE_START_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The link currently being awaited, so the error can name it. Recorded on
  // every guard: the budget is one-shot, but the chain it guards is several
  // links long and only the last one can have gone quiet when it runs out.
  let awaiting = 'the start';
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HandsfreeStartTimeoutError(awaiting)), timeoutMs);
  });

  return {
    guard<T>(link: string, step: Promise<T>): Promise<T> {
      awaiting = link;
      return Promise.race([step, expired]);
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** True for the error `startDeadline` raises, so a caller can tell it apart. */
export function isStartTimeout(error: unknown): error is HandsfreeStartTimeoutError {
  return error instanceof HandsfreeStartTimeoutError;
}
