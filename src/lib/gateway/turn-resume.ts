// ─── Re-attaching to turns the PC is still running ────────────────
//
// The Gate owns a turn for as long as it runs; the phone is only one of the
// subscribers that can watch it. This module is the pure half of that: given
// what the journal says and what this process is already following, what should
// the app do? The provider owns the other half (the reads, the stream, the
// backoff timer), so every decision below is testable without a client.
//
// Design: `docs/design/durable-turns.md` §4.

import { turnSettlement, type TurnMeta, type TurnSettlement } from '@/lib/gateway/turns';

/**
 * Windows at which a dropped turn stream is re-attached.
 *
 * There is no last window: a turn the Gate is still running is followed for as
 * long as it runs, because the Gate itself allows a detached turn to work for
 * hours. The old ladder stopped after 20s, so a reply that landed in minute
 * five was never picked up and the thread said "Connection lost" until the
 * operator reloaded by hand.
 */
export const TURN_RESUME_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** The wait before re-attachment `attempt` (0 = the first), capped at the last window. */
export function turnResumeBackoffMs(attempt: number): number {
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return TURN_RESUME_BACKOFF_MS[Math.min(index, TURN_RESUME_BACKOFF_MS.length - 1)];
}

/** The settlement kinds that change a bubble; `running`/`unknown` never do. */
export type TurnSettlementVerdict = Exclude<TurnSettlement, { kind: 'running' | 'unknown' }>;

export type TurnResumeAction =
  /** Follow the turn: rebuild its bubble and read its events from `after`. */
  | { kind: 'attach'; turnId: string; after: number }
  /** Settle the bubble from the journal — the turn's outcome is known. */
  | { kind: 'settle'; turnId: string; settlement: TurnSettlementVerdict }
  /** Nothing to do (already followed, or a status this build cannot read). */
  | { kind: 'nothing'; turnId: string }
  /** The turn is no longer this thread's business. */
  | { kind: 'stand-down'; reason: 'thread-changed' | 'other-thread' };

/**
 * What to do about one turn the journal named.
 *
 * The standing rules, in order:
 *  - a thread this resume was not armed for, or a turn belonging to another
 *    thread, stands down: the operator moved on and nothing here is wanted;
 *  - a thread whose session the history read has not named yet is the same rule
 *    one step weaker: a journal read with no session filter answers for every
 *    thread the Gate is running, so only a turn this app STARTED — one it minted
 *    the id for and still holds on a bubble or an outbox row — is shown here;
 *  - a turn this process is already streaming is left alone (a second
 *    subscriber for the same bubble would duplicate every delta);
 *  - a running turn is followed from the last seq THIS PROCESS rendered — never
 *    from the journal's own `lastSeq`, because a process that has seen nothing
 *    needs the whole replay to rebuild an empty bubble;
 *  - a finished turn is settled by identity rather than by matching text.
 */
export function decideTurnResume(request: {
  turn: TurnMeta;
  /** Turn ids this process is streaming right now. */
  streamingTurnIds?: readonly string[];
  /** The last journal seq this process rendered, per turn. */
  lastSeqByTurnId?: Readonly<Record<string, number>>;
  /** The thread on screen, when there is one. */
  threadSessionId?: string;
  /**
   * True while the history read that names this thread's session has not
   * settled: nothing here can yet say whose turn the journal is talking about.
   */
  threadSessionPending?: boolean;
  /**
   * Turn ids this process minted and still holds: on a bubble of its own, or on
   * an outbox row. The only turns a sessionless thread can be shown, because it
   * has no id to compare them against.
   */
  localTurnIds?: readonly string[];
  /** False once the thread or gateway this was armed for is gone. */
  stillCurrent?: boolean;
}): TurnResumeAction {
  const { turn } = request;
  if (request.stillCurrent === false) {
    return { kind: 'stand-down', reason: 'thread-changed' };
  }
  if (turn.sessionId && request.threadSessionId && turn.sessionId !== request.threadSessionId) {
    return { kind: 'stand-down', reason: 'other-thread' };
  }
  // The thread has no session id yet, so a journal read scoped to it went out
  // unfiltered and answered for every thread this Gate is running. Only a turn
  // this app started is certainly ours; the rest belongs to a conversation
  // nobody on this device is looking at.
  if (
    request.threadSessionPending &&
    !request.localTurnIds?.includes(turn.turnId)
  ) {
    return { kind: 'stand-down', reason: 'other-thread' };
  }
  const settlement = turnSettlement(turn);
  if (settlement.kind === 'running') {
    if (request.streamingTurnIds?.includes(turn.turnId)) {
      return { kind: 'nothing', turnId: turn.turnId };
    }
    const rendered = request.lastSeqByTurnId?.[turn.turnId];
    return {
      kind: 'attach',
      turnId: turn.turnId,
      after: typeof rendered === 'number' && rendered > 0 ? rendered : 0,
    };
  }
  if (settlement.kind === 'unknown') {
    return { kind: 'nothing', turnId: turn.turnId };
  }
  return { kind: 'settle', turnId: turn.turnId, settlement };
}