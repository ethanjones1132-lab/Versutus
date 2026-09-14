/**
 * D7 council surface (FUTURE-ITEMS.md §D7, "Council mode — broadcast and
 * compare") — the copy and capture folds the comparison sheet renders, so
 * the component owns no decision of its own.
 *
 * The council is NOT a group room: no @mention scoping, no multi-round plan,
 * no owned pipeline. The fan-out rides `planCouncil` (council.ts), each leg
 * rides the per-Bot send path other surfaces already take
 * (`sendChatInput(text, { botId })`), and every answer is captured where the
 * send already lands — the Bot's own Bot Chat the destination rides to
 * (ADR 0012). No new wire format, no new fetches, exactly as the spec says.
 */

import type { ChatMessage } from '@/lib/gateway/types';
import type { CouncilResultSlot } from '@/lib/gateway/council';

/** One Bot is a private chat, not a council; two make a comparison real. */
export const COUNCIL_MIN_BOTS = 2;

/**
 * Where the answers live, said the same way on every surface: each leg is a
 * send into THAT Bot's canonical Bot Chat (ADR 0012), so the comparison's
 * copies stay open threads the operator can keep talking to. Never called
 * push, never called a room — it is neither.
 */
export const COUNCIL_DESTINATION_COPY =
  'Answers are sent to their own Bot Chat — open one to keep the thread going.';

/** What the roster row promises: a comparison, before any send exists. */
export function councilEntryCopy(): { title: string; subtitle: string } {
  return { title: 'Council', subtitle: 'Ask 2+ Bots the same prompt, answers side by side' };
}

/**
 * The send control's word and state: a council needs at least two picked
 * Bots, the same prompt for every one of them, and an idle surface. Bad
 * shapes and an in-flight council read as an invitation with the button
 * dead — never as a send that happened.
 */
export function councilSendCopy(input: {
  pickedCount: number;
  hasPrompt: boolean;
  busy: boolean;
}): { label: string; enabled: boolean } {
  return {
    label: input.busy ? 'Asking…' : 'Send to council',
    enabled: !input.busy && input.pickedCount >= COUNCIL_MIN_BOTS && input.hasPrompt,
  };
}

/**
 * The scope line while the sheet is idle: how many of the roster's askable
 * Bots the operator has picked. In flight it says the same fact no louder —
 * the progress line carries the count, and a hard-broken leg never moves it.
 */
export function councilScopeCopy(input: {
  pickedCount: number;
  routableCount: number;
  busy: boolean;
}): string {
  return `${input.pickedCount} of ${input.routableCount} Bots picked`;
}

/** The one line the sheet says about what every leg shares. */
export function councilPromptCopy(): string {
  return 'One prompt, every picked Bot. Answers stay in each Bot Chat.';
}

/**
 * What a prompt shared by several Bots may not be: a command. `sendChatInput`
 * would dispatch a slash line in whichever Bot Chat the leg is scoped to,
 * once per leg — the copy refuses the prompt before any send happens.
 */
export function councilPromptIssue(prompt: string): string | undefined {
  return prompt.trim().startsWith('/')
    ? 'The council sends one prompt, not a command — drop the leading slash.'
    : undefined;
}

/**
 * How long one leg's send may owe its reply before the sheet answers
 * "timed out" for that Bot and moves on. The reply itself may still land in
 * the Bot Chat later — the ceiling is about the comparison, not a kill.
 */
export const COUNCIL_LEG_REPLY_TIMEOUT_MS = 90_000;

/**
 * The live progress line: N legs planned, M settled — a settled leg is an
 * answer arrived or a leg that failed on its own (the verdict rides the
 * slot), so the count stops growing only when every leg has spoken.
 */
export function councilProgressCopy(settled: number, planned: number): string {
  const noun = planned === 1 ? 'Bot' : 'Bots';
  const count =
    settled === 0 ? 'no answers yet' : `${settled} answer${settled === 1 ? '' : 's'} in`;
  return `Asking ${planned} ${noun}… ${count}`;
}

/**
 * One Bot column's status line. The order is the honesty order: a leg that
 * failed answers with its cause (never as a reply), a leg mid-flight says it
 * is being asked, and an unfilled slot owes a reply rather than fabricating
 * one. The roster-verified routing verdict rides the row subtitle elsewhere —
 * this line is only about this leg's outcome.
 */
export function botResultLine(slot: CouncilResultSlot, busy: boolean): string {
  if (typeof slot.error === 'string') return `Failed: ${slot.error}`;
  if (typeof slot.reply?.text === 'string') return slot.reply.text;
  return busy ? 'Asking…' : 'No answer yet.';
}

/**
 * Take the leg's own answer off the destination Bot Chat's transcript: the
 * latest real assistant text. Command machinery (ephemeral or not) is never
 * an answer, a streaming row is not final, and a transcript with none
 * answers undefined so the slot owes what it owes.
 */
export function latestReplyText(
  messages: readonly ChatMessage[],
  afterPrompt?: string,
): string | undefined {
  const prompt = typeof afterPrompt === 'string' ? afterPrompt.trim() : undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    // Everything before the leg's own prompt belongs to an earlier turn.
    if (prompt && message.role === 'user' && message.text.trim() === prompt) return undefined;
    if (message.role !== 'assistant') continue;
    if (message.command) continue;
    if (message.streaming) continue;
    const text = message.text.trim();
    if (text.length > 0) return text;
  }
  return undefined;
}
