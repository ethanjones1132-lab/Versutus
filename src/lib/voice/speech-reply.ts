// ─── What the speaker owes the transcript ─────────────────────────────────
// Solution B2 (`FUTURE-ITEMS.md:431-435`): with the speaker on, "each completed
// assistant message is spoken", and "a new user message or toggle-off calls
// `Speech.stop()` and clears the queue". The chat screen watches the
// transcript's own tail and asks this fold what to do, so the rule lives in one
// place with a test rather than inside a screen this suite cannot mount.
//
// "Completed" is the transcript's own word for it: a bubble that is still
// `streaming` is a reply being written, and an `interrupted` one is a reply the
// connection dropped mid-sentence — neither is spoken as if the Bot had
// finished saying it. A command whose output is still arriving
// (`command.status === 'running'`) is not finished either. A system message is
// not the Bot answering, so it is never spoken.

import type { ChatMessage } from '@/lib/gateway/types';

/** What the speaker does about the newest message in the transcript. */
export type SpeakerAction =
  | { kind: 'speak'; text: string }
  /** A new turn: whatever is being read is silenced. */
  | { kind: 'silence' }
  | { kind: 'nothing' };

/**
 * What the speaker owes for the newest message in the transcript. A user turn
 * silences the queue — the screen decides whether this conversation is
 * speaking at all, and this fold only says the turn ends it. A finished
 * assistant message carrying words is read aloud, verbatim. Everything else is
 * nothing: a reply still streaming, a reply the connection interrupted, a
 * command still producing output, a system line, and a message with no words
 * in it.
 */
export function speakerAction(message: ChatMessage | undefined): SpeakerAction {
  if (!message) return { kind: 'nothing' };
  if (message.role === 'user') return { kind: 'silence' };
  if (message.role !== 'assistant') return { kind: 'nothing' };
  if (message.streaming || message.interrupted) return { kind: 'nothing' };
  if (message.command?.status === 'running') return { kind: 'nothing' };
  if (!message.text.trim()) return { kind: 'nothing' };
  return { kind: 'speak', text: message.text };
}
