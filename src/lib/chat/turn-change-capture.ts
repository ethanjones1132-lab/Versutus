// ─── Write one turn's record when the turn finishes ────────────────
// VS-094, slice 4: the moment a turn ends is the last moment its evidence is
// live. `ChatToolCall.detail` is not kept by the Gate's history (design §1), so
// a turn that is never captured here can only ever be "Changes are unavailable"
// on a later mount.
//
// This is the write seam the row reads back. It owns no storage format and no
// second persistence path: `collectTurnChanges` builds the record from the
// evidence that is live right now, and the landed store (the app passes the
// shared one over `keyValueStorage`) caps, serialises and keys it on `turnId`.
//
// What it will not do:
//   - write for a turn with no `turnId`, or one whose window cannot be bounded;
//   - invent evidence on an interrupted or cancelled turn: those save only when
//     a write-like call or a diff already says something;
//   - let a rejected save reach the transcript. The row keeps its stable
//     "unavailable" line instead.
//
// Paths, statuses and counts only. The collector discards `detail` after
// reading paths, and the store's whitelist makes `content`, `patch`, `detail`
// and `output` unstorable even if a caller passed them.

import type { ChatMessage } from '@/lib/gateway/types';
import type {
  TurnChangeFrame,
  TurnJournalRecord,
} from '@/lib/chat/turn-change-collector';
import { collectTurnChanges } from '@/lib/chat/turn-change-collector';
import type {
  TurnChangeCaps,
  TurnChangeRecord,
  TurnDiffRow,
} from '@/lib/chat/turn-changes';
import type { TurnChangeStore } from '@/lib/chat/turn-change-store';

/**
 * How the turn ended.
 *
 * A finished turn always saves — an empty file list is the honest "nothing
 * changed" that keeps a later mount from reading a store miss as unavailable.
 * An interrupted or stopped turn has no such claim to make, so it writes only
 * when the evidence it streamed already names a write-like call or a diff.
 */
export type TurnChangeOutcome = 'finished' | 'interrupted';

/** The only store shape this seam needs; the landed store satisfies it. */
export type TurnChangeSaveStore = Pick<TurnChangeStore, 'save'>;

export type CaptureTurnChangeInput = {
  /** The Gate turn this record keys on. Absent means nothing is written. */
  turnId?: string;
  sessionId?: string;
  backendId?: string;
  /** This turn's messages, including the one that just finished. */
  turnMessages?: readonly ChatMessage[];
  /** Live tool frames, when the caller kept them; messages already carry them. */
  frames?: readonly TurnChangeFrame[];
  /** The journal's meta for this turn, when the caller has it. */
  journalMeta?: TurnJournalRecord | null;
  diffBefore?: readonly TurnDiffRow[] | null;
  diffAfter?: readonly TurnDiffRow[] | null;
  outcome?: TurnChangeOutcome;
  caps?: TurnChangeCaps;
  store: TurnChangeSaveStore;
};

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Build and persist one turn's change record at the end of the turn.
 *
 * Returns the stored record, or `null` when there is nothing honest to write:
 * no turn id, no window, an interrupted turn with no evidence, or a save the
 * adapter refused. A `null` here is exactly the state the row already renders
 * as "Changes are unavailable for this turn"; it is never thrown into the
 * transcript, because a turn finishing must not fail over its change list.
 */
export async function captureTurnChange(
  input: CaptureTurnChangeInput,
): Promise<TurnChangeRecord | null> {
  const turnId = nonEmpty(input.turnId);
  if (!turnId) return null;

  const journalMeta = input.journalMeta ?? null;
  const sessionId = nonEmpty(input.sessionId) ?? nonEmpty(journalMeta?.sessionId);
  const backendId = nonEmpty(input.backendId)
    ?? nonEmpty(journalMeta?.backendId ?? undefined);
  if (!sessionId || !backendId) return null;

  // Everything below is best-effort: a turn finishing must never fail over its
  // change list, and nothing here may escape as a rejection into the transcript.
  try {
    const record = collectTurnChanges({
      turnId,
      sessionId,
      backendId,
      messages: input.turnMessages,
      frames: input.frames,
      journalMeta,
      diffBefore: input.diffBefore,
      diffAfter: input.diffAfter,
      caps: input.caps,
    });
    // No window means no attribution. An interrupted turn with an empty file
    // list is the same: absence is not evidence, so it writes nothing rather
    // than a record that would read as "this turn changed nothing".
    if (!record) return null;
    if ((input.outcome ?? 'finished') !== 'finished' && record.files.length === 0) {
      return null;
    }
    // The store keys this on `turnId`, so finalising or re-rendering the same
    // turn again overwrites the same key instead of adding a second record.
    return await input.store.save(record);
  } catch {
    // Nothing to log that would not risk carrying an argument. The row's own
    // missing record is the report.
    return null;
  }
}
