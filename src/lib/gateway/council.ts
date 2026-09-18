// ─── Council mode: one prompt, several Bots ───────────────────────────────
// D7 (`FUTURE-ITEMS.md`): send one prompt to several Bots and compare the
// answers side by side, without shipping full group chats first. The fan-out
// is the part that must be right: one Bot failing is that Bot's column, never
// the whole council. The side-by-side view is the next slice; this module is
// the comparison data it draws.
//
// It is deliberately transport-free: the caller supplies a `send` per target,
// so the existing per-Bot send path stays the one place a message is sent.

/** One Bot the council asks. */
export type CouncilTarget = { botId: string; label: string };

/** One Bot's place in the comparison. */
export type CouncilColumn = CouncilTarget &
  (
    | { state: 'answered'; text: string }
    | { state: 'silent' }
    | { state: 'failed'; error: string }
  );

/**
 * The Bots the council may ask: trimmed, deduped by Bot id, capped, in the
 * roster's own order. An empty or duplicate row is dropped rather than asked
 * twice.
 */
export function councilTargets(
  bots: { id: string; displayName?: string }[],
  limit = 3,
): CouncilTarget[] {
  const seen = new Set<string>();
  const targets: CouncilTarget[] = [];
  for (const bot of bots) {
    const botId = bot.id.trim();
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    targets.push({ botId, label: bot.displayName?.trim() || botId });
    if (targets.length >= limit) break;
  }
  return targets;
}

/**
 * Ask every target the same prompt, in parallel, and keep the roster's order.
 * A rejected send is that target's failed column; a blank or absent answer is
 * that Bot's quiet column — the Gate's "nothing to add" — so a silence never
 * reads as an answer or an error.
 */
export async function runCouncil(
  prompt: string,
  targets: CouncilTarget[],
  send: (target: CouncilTarget, prompt: string) => Promise<string>,
): Promise<CouncilColumn[]> {
  return Promise.all(
    targets.map(async (target): Promise<CouncilColumn> => {
      try {
        const text = await send(target, prompt);
        if (!text.trim()) return { ...target, state: 'silent' };
        return { ...target, state: 'answered', text };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ...target, state: 'failed', error: detail };
      }
    }),
  );
}

/** One line above the columns: how many answered, honestly. */
export function councilSummaryCopy(columns: CouncilColumn[]): string {
  const total = columns.length;
  if (total === 0) return 'No Bots to compare.';
  const answered = columns.filter((column) => column.state === 'answered').length;
  if (answered === total) return total === 2 ? 'Both answered.' : `All ${total} answered.`;
  return `${answered} of ${total} answered.`;
}

// ─── The view's send (slice 2) ────────────────────────────────────────────
// The app has no per-Bot "ask and await one answer" call, so the council
// reuses the one surface that does return text per Bot: the Gate's group
// round. It is one transient room per comparison, created and deleted around
// the send; `runCouncil` stays the ordering and failure-isolation layer over
// the replies that round returned.

export const COUNCIL_ROOM_PREFIX = 'Council · ';
const COUNCIL_ROOM_NAME_MAX = 50;

/** A short, named label for the transient room a comparison runs in. */
export function councilRoomName(prompt: string): string {
  const trimmed = prompt.trim();
  const label = trimmed
    ? trimmed.slice(0, COUNCIL_ROOM_NAME_MAX - COUNCIL_ROOM_PREFIX.length)
    : 'comparison';
  return `${COUNCIL_ROOM_PREFIX}${label}`;
}

/** Why the council is off on a gateway with no rooms — a capability, not an error. */
export function councilDisabledCopy(): string {
  return 'This gateway does not offer group rooms, so a council cannot compare Bots here.';
}

/**
 * What a prompt shared by several Bots may not be: a command. A `/` line
 * would go to every Bot as plain text — the council refuses it before any
 * send happens.
 */
export function councilPromptIssue(prompt: string): string | undefined {
  return prompt.trim().startsWith('/')
    ? 'The council sends one prompt, not a command — drop the leading slash.'
    : undefined;
}
