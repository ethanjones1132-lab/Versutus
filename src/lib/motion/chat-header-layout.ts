export type ChatHeaderChipLayout = 'row' | 'stacked';

/** Matches Spacing.three * 2 — wrap paddingHorizontal. Kept numeric so tests skip tokens. */
const WRAP_HORIZONTAL = 32;
/** Matches Spacing.two * 2 — GlassSurface padding on the card. */
const CARD_PADDING = 16;
const ORB = 34;
const BACK = 32;
const OVERFLOW = 32;
/** Chip maxWidth in chat-header. Worst case so a long session title still fits. */
export const CHAT_HEADER_CHIP_MAX_WIDTH = 120;
/** Matches Spacing.two — card row gap. */
const GAP = 8;
/** Title column keeps at least this much, or the chips move to a second row. */
const MIN_TITLE = 64;

const THREAD_CHROME = WRAP_HORIZONTAL + CARD_PADDING + ORB + BACK + OVERFLOW;

/**
 * Whether the session and model chips share the title row or sit under it.
 *
 * Opening Bot Chat puts orb, back, title, both chips, and overflow on one
 * unwrapped row. Two 120-wide chips plus that chrome overflow a 390-wide
 * phone, so the session chip is clipped and untappable. Stacking keeps both.
 */
export function chatHeaderChipLayout(input: {
  windowWidth: number;
  model: boolean;
  session: boolean;
}): ChatHeaderChipLayout {
  const chips = (input.model ? 1 : 0) + (input.session ? 1 : 0);
  if (chips === 0) return 'row';
  if (!Number.isFinite(input.windowWidth) || input.windowWidth <= 0) return 'stacked';

  // orb, back, titles, overflow, plus each chip
  const items = 4 + chips;
  const gaps = (items - 1) * GAP;
  const needed = THREAD_CHROME + chips * CHAT_HEADER_CHIP_MAX_WIDTH + gaps + MIN_TITLE;
  return needed > input.windowWidth ? 'stacked' : 'row';
}
