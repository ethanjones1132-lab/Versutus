/**
 * The displayed text may be shorter than the wire cursor after a replay gap.
 * Keep the suffix that arrived, without inventing the missing text or treating
 * the display length as a wire offset for subsequent deltas. History reload
 * remains responsible for canonical reconciliation after the live turn.
 */
export function foldCallReplyDelta(
  text: string,
  cursor: number,
  delta: string,
  offset = cursor,
): { text: string; cursor: number } {
  const overlap = Math.max(0, cursor - offset);
  return {
    text: text + delta.slice(overlap),
    cursor: Math.max(cursor, offset + delta.length),
  };
}
