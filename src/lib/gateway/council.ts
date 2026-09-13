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
 * A rejected send is that target's failed column; a blank answer is a failure
 * too, so an empty column never reads as an answer.
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
        if (!text.trim()) return { ...target, state: 'failed', error: 'empty answer' };
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
