// ─── Where the activity block sits in the reply ─────────────────────
// The assistant bubble carries two kinds of content: the words the model wrote
// (`text`) and the activity block (thinking + tool cards). The block is one
// quiet expandable line, so it cannot be split into several cards — but it also
// must not jump above words that were written before it existed. A fast turn
// that streamed "Let me check." → a shell call → "All good." used to render the
// card first and both sentences below it, i.e. out of order.
//
// `ChatMessage.activityAnchor` records the text length at the moment the block
// first held anything, so this fold can keep the earlier text ABOVE the block
// and the later text below it. Everything here is pure; the bubble renders what
// it returns and nothing else.

/** A reply body split around the activity block's place in arrival order. */
export type ActivitySplit = {
  /** Text written before the block appeared, rendered above it. */
  before: string;
  /** Text written after it, rendered below it (the body, in the usual place). */
  after: string;
};

/** An odd number of fence lines means a code block the text has not closed. */
const FENCE_LINE = /^[ \t]*(?:```|~~~)/gm;

function hasUnclosedFence(text: string): boolean {
  const fences = text.match(FENCE_LINE);
  return fences !== null && fences.length % 2 === 1;
}

/**
 * Split a reply body around its activity anchor.
 *
 * The split only ever happens on a line boundary, and only when neither half
 * leaves a code fence open: markdown is parsed per half, so a mid-line or
 * mid-fence cut would turn one paragraph (or one code block) into two broken
 * ones. When any of that would happen the whole body stays below the block —
 * the arrangement the transcript has always had — rather than trading an
 * ordering bug for a rendering one.
 *
 * `before` is empty whenever there is nothing honestly above the block: no
 * anchor (history rows, command turns), an anchor at the very start, or an
 * anchor past the end (a settled turn whose text was replaced wholesale).
 */
export function splitBodyAroundActivity(
  text: string,
  anchor: number | undefined,
): ActivitySplit {
  const whole: ActivitySplit = { before: '', after: text };
  if (!text) return whole;
  if (anchor === undefined || !Number.isFinite(anchor)) return whole;

  const limit = Math.max(0, Math.min(Math.floor(anchor), text.length));
  if (limit <= 0 || limit >= text.length) return whole;

  // The last line break that finished before the block appeared. Cutting here
  // keeps every line whole.
  const newline = text.lastIndexOf('\n', limit - 1);
  if (newline < 0) return whole;

  const cut = newline + 1;
  const before = text.slice(0, cut);
  const after = text.slice(cut);
  if (!before.trim() || !after.trim()) return whole;
  if (hasUnclosedFence(before) || hasUnclosedFence(after)) return whole;

  return { before, after };
}
