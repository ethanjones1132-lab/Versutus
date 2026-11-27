// ─── Which change row a turn may show ──────────────────────────────
// VS-094, slice 3: the row under the bubble, and the seam that answers it.
//
// A finished turn is answered by the local store, keyed on `turnId`. Only a
// turn that is still streaming falls back to `collectTurnChangesFromJournal`,
// because the store cannot hold a record before the turn ends — the design
// names exactly those two seams (docs/plans/2026-11-26-turn-change-list-design.md
// §2, §3).
//
// A finished turn whose record is missing stays `unavailable`. It is never
// recomputed from reloaded history: history drops the tool arguments, so a
// recomputed list would be a guess wearing a record's clothes.

import type { ChatMessage } from '@/lib/gateway/types';
import type { TurnChangeRecord, TurnDiffRow } from '@/lib/chat/turn-changes';
import type {
  TurnChangeFrame,
  TurnJournalMetaFetcher,
} from '@/lib/chat/turn-change-collector';
import { collectTurnChangesFromJournal } from '@/lib/chat/turn-change-collector';

/**
 * What one assistant bubble may show:
 * - `none`: no row at all (no turn id, still streaming with no journal, or a
 *   streamed record that turned out to have no write-like call);
 * - `unavailable`: the store answered `null` for a finished turn;
 * - `ready`: a record whose summary decides whether the row is visible.
 */
export type TurnChangeRowState =
  | { status: 'none' }
  | { status: 'unavailable' }
  | { status: 'ready'; record: TurnChangeRecord };

/** The only store shape this resolver needs; the landed store satisfies it. */
export type TurnChangeRecordStore = {
  load(turnId: string): Promise<TurnChangeRecord | null>;
};

export type ResolveTurnChangeRowStateInput = {
  /** The Gate turn this bubble is the reply to. Absent means no row. */
  turnId?: string;
  /** True while the turn is still live; only then may the journal be consulted. */
  streaming?: boolean;
  sessionId?: string;
  backendId?: string;
  messages?: readonly ChatMessage[];
  frames?: readonly TurnChangeFrame[];
  diffBefore?: readonly TurnDiffRow[] | null;
  diffAfter?: readonly TurnDiffRow[] | null;
  store: TurnChangeRecordStore;
  /**
   * The journal read, injected. Omitted while streaming means "nothing honest
   * to show yet", not "unavailable": an unfinished turn is not a missing one.
   */
  readJournalMeta?: TurnJournalMetaFetcher;
};

/**
 * Resolve one turn's row state (design §2, §3).
 *
 * The journal is consulted for a streaming turn only. A stored record is
 * loaded for a finished turn only, and a `null` there is `unavailable` — the
 * caller prints the one stable line, never an empty list standing in for a
 * guess.
 */
export async function resolveTurnChangeRowState(
  input: ResolveTurnChangeRowStateInput,
): Promise<TurnChangeRowState> {
  const turnId = typeof input.turnId === 'string' && input.turnId.length > 0
    ? input.turnId
    : undefined;
  if (!turnId) return { status: 'none' };

  if (input.streaming) {
    if (!input.readJournalMeta) return { status: 'none' };
    const record = await collectTurnChangesFromJournal({
      turnId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.backendId ? { backendId: input.backendId } : {}),
      ...(input.messages ? { messages: input.messages } : {}),
      ...(input.frames ? { frames: input.frames } : {}),
      diffBefore: input.diffBefore,
      diffAfter: input.diffAfter,
      readJournalMeta: input.readJournalMeta,
    });
    // A live turn with no record yet shows nothing; it is not a finished
    // turn whose record went missing.
    return record ? { status: 'ready', record } : { status: 'none' };
  }

  try {
    const record = await input.store.load(turnId);
    return record ? { status: 'ready', record } : { status: 'unavailable' };
  } catch {
    // A refused read is a missing answer, and the row says so plainly.
    return { status: 'unavailable' };
  }
}
