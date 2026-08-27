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
  /** System font scale from useWindowDimensions(). Capped at 1.4 to match Text caption cap. */
  fontScale?: number;
}): ChatHeaderChipLayout {
  const chips = (input.model ? 1 : 0) + (input.session ? 1 : 0);
  if (chips === 0) return 'row';
  if (!Number.isFinite(input.windowWidth) || input.windowWidth <= 0) return 'stacked';

  const rawScale = input.fontScale;
  const scale =
    Number.isFinite(rawScale as number) && (rawScale as number) > 0
      ? Math.min(rawScale as number, 1.4)
      : 1;

  // orb, back, titles, overflow, plus each chip — chip and title widths grow with fontScale
  const items = 4 + chips;
  const gaps = (items - 1) * GAP;
  const needed =
    THREAD_CHROME + chips * CHAT_HEADER_CHIP_MAX_WIDTH * scale + gaps + MIN_TITLE * scale;
  return needed > input.windowWidth ? 'stacked' : 'row';
}

/** Effective chip maxWidth that keeps the label inside the pill at a given fontScale. */
export function chatHeaderChipMaxWidth(fontScale?: number): number {
  const scale =
    Number.isFinite(fontScale as number) && (fontScale as number) > 0
      ? Math.min(fontScale as number, 1.4)
      : 1;
  // Shrink the cap so larger text still fits within the same visual budget.
  return Math.round(CHAT_HEADER_CHIP_MAX_WIDTH / scale);
}

/** Headline: a group is the room name; a thread is the backend, else the gateway. */
export function chatHeaderTitle(input: {
  gatewayName: string;
  backendLabel?: string;
  groupName?: string;
}): string {
  const groupName = input.groupName?.trim();
  if (groupName) return groupName;
  return input.backendLabel ?? input.gatewayName;
}

/** Session chip only on a thread that can open Sessions. Rooms never show one. */
export function chatHeaderSessionChip(
  input:
    | { surface: 'group' }
    | { surface: 'thread'; sessionLabel?: string; sessionPress: boolean },
): boolean {
  if (input.surface === 'group') return false;
  return Boolean(input.sessionLabel && input.sessionPress);
}
