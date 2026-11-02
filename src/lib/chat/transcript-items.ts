// ─── Transcript rows ───────────────────────────────────────────────
// One FlatList row is a message plus the day-divider decision taken from it
// and its predecessor. The fold runs once per message-array change, but a
// streaming turn rebuilds that array on every flush, and a rebuilt array used
// to hand every row a new object — so `MessageBubble`'s memo saw a changed
// `item` for bubbles that had not moved and re-rendered the whole transcript.
//
// This fold carries the previous row forward when its message object and its
// divider decision are unchanged; only the rows the flush touched are new.
// The result is identical to a from-scratch rebuild: same length, same order,
// same labels and same `showDivider` flags, including the `Today` →
// `Yesterday` rollover, because the label is compared as well as the message.

import type { ChatMessage } from '@/lib/gateway/types';

/** One transcript row: the message plus the day-divider decision. */
export type TranscriptItem = {
  message: ChatMessage;
  label: string | undefined;
  showDivider: boolean;
};

/** The day-divider copy for a timestamp (the cached formatter in production). */
export type DayDividerLabel = (timestamp: number) => string;

/**
 * Fold messages into transcript rows, reusing the previous row object when the
 * message is the same object and the divider decision did not move.
 *
 * `previous` is the last folded list (empty on the first pass). A row is
 * carried forward only when identity and both derived fields agree, so the
 * caller's `renderItem` sees a stable object for every untouched bubble and a
 * new one for the bubble the flush changed.
 */
export function stableTranscriptItems(
  messages: readonly ChatMessage[],
  labelFor: DayDividerLabel,
  previous: readonly TranscriptItem[] = [],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let previousLabel: string | undefined;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const label = message.timestamp ? labelFor(message.timestamp) : undefined;
    const showDivider = !!label && label !== previousLabel;
    previousLabel = label;

    const carried = previous[index];
    items.push(
      carried !== undefined &&
        carried.message === message &&
        carried.label === label &&
        carried.showDivider === showDivider
        ? carried
        : { message, label, showDivider },
    );
  }

  return items;
}
