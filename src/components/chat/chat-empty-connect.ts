import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The empty chat's first connection, owned by the press that started it.
 *
 * `retryAutoConnect` reports its failure through the provider rather than by
 * rejecting, and the screen hands this hook that promise. Whether an attempt
 * finished is therefore the promise's business: a quick cycle, a batched
 * update, or a failure before the phase ever reaches `searching` leaves no
 * observed `attempting` edge to watch. `attempting` remains the secondary
 * source — it can hold the control pending for the automatic cycle that
 * started without a press — but it never decides when a pressed attempt ends.
 */

export type ChatEmptyConnectOptions = {
  onConnect: () => void | Promise<unknown>;
  /**
   * The screen's own automatic searching/connecting cycle. Optional: a caller
   * that never passes it still gets pending and failed from the promise alone.
   */
  attempting?: boolean;
};

export type ChatEmptyConnectState = {
  /** The control is busy: this press, or the automatic cycle — whichever. */
  pending: boolean;
  /** This press is in flight, so the empty state can say so in its own words. */
  pressing: boolean;
  /** The last press-started attempt settled with no gateway in sight. */
  failed: boolean;
  /** The press. Locked while busy, so a second tap cannot start another. */
  start: () => void;
};

type Phase = 'idle' | 'pending' | 'failed';

export function useChatEmptyConnect({
  onConnect,
  attempting = false,
}: ChatEmptyConnectOptions): ChatEmptyConnectState {
  const [phase, setPhase] = useState<Phase>('idle');
  // The lock is a ref, not state: two taps inside one frame both see the render
  // that was on screen when they fired, and only the ref is already true for
  // the second one.
  const lockedRef = useRef(false);
  // A gateway connecting in the background unmounts this empty state before the
  // promise settles; the settle must not then write into a dead tree.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const start = useCallback(() => {
    if (lockedRef.current || attempting) return;
    lockedRef.current = true;
    setPhase('pending');

    // Resolve and reject are both "the attempt is over". The empty state is
    // mounted only while no gateway is active, so an attempt that ends here
    // ended without a gateway: the one honest next state is `failed`.
    const done = () => {
      if (!mountedRef.current) return;
      lockedRef.current = false;
      setPhase('failed');
    };

    try {
      const completion = onConnect();
      if (completion === undefined) {
        // Legacy shared callers fire and forget. They provide no completion
        // signal, so preserve their behavior instead of inventing a failure.
        lockedRef.current = false;
        if (mountedRef.current) setPhase('idle');
        return;
      }
      void Promise.resolve(completion).then(done, done);
    } catch {
      // A synchronous throw never reaches the promise; the press still ends,
      // rather than spinning forever with its lock held.
      done();
    }
  }, [attempting, onConnect]);

  return {
    // The automatic cycle can hold the control pending even though no press
    // owns it; it can never end one.
    pending: phase === 'pending' || attempting,
    pressing: phase === 'pending',
    failed: phase === 'failed' && !attempting,
    start,
  };
}

/**
 * The failed attempt must not leave the idle sentence on screen — that sentence
 * is what the old dead-end said while nothing was happening.
 */
export const CHAT_EMPTY_FAILED_COPY =
  'No gateway answered. Start the gateway on your PC, then try again or set up its address.';

/** Said only while this press is in flight, at once, before any phase shows. */
export const CHAT_EMPTY_PENDING_COPY = 'Reaching your gateway…';
