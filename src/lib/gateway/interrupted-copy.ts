/**
 * Label on an interrupted assistant bubble.
 *
 * The chat screen resends the previous user turn as a new message.
 * This is not a continue of the partial reply.
 */
export function interruptedSendAgainLabel(): string {
  return 'Send again';
}

/**
 * Why a turn the GATE ended says it ended.
 *
 * `docs/design/durable-turns.md` §3.2: an `interrupted` turn carries the
 * reason — `gate_restart`, `stalled` or `max_age`. Naming it is the whole point
 * of the marker: the operator can tell "the PC restarted the Gate under this"
 * from "this made no progress for a long time" and from a model failure, and
 * none of those is a finished answer.
 */
export function interruptedTurnCopy(reason?: string | null): string {
  switch (reason) {
    case 'gate_restart':
      return 'The Gate restarted while this was running.';
    case 'stalled':
    case 'max_age':
      return 'The PC stopped this turn: it made no progress for a long time.';
    default:
      return 'The PC stopped this turn before it finished.';
  }
}
