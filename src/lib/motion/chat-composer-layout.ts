import { chatHeaderChipLayout } from './chat-header-layout';

/**
 * Base header chrome height on a phone, excluding the status-bar inset.
 * Row = single-line header (orb + title + chips on one row).
 * Stacked = chips wrap to a second row (360dp + 2 chips), ~24px taller.
 * Values are the measured wrap (16) + card padding (16) + orb/chip row;
 * 72/96 match the previous magic 72 plus the 24px stack delta noted in
 * the phase-3 audit.
 */
export const CHAT_COMPOSER_KAV_BASE_ROW = 72;
export const CHAT_COMPOSER_KAV_BASE_STACKED = 96;

/**
 * KeyboardAvoidingView vertical offset for the chat composer.
 *
 * iOS: the KAV's `padding` behavior must clear the navigation/status bar
 * (`topInset`) plus the actual header chrome. The header stacks on narrow
 * phones when both chips are present, so the offset grows by ~24px.
 * Android/web: KAV is not used (ComposerKeyboardLift owns IME lift), so
 * the offset is 0.
 */
export function chatComposerKeyboardOffset(input: {
  platform: string;
  windowWidth: number;
  topInset: number;
  hasModelChip?: boolean;
  hasSessionChip?: boolean;
}): number {
  if (input.platform !== 'ios') return 0;
  const hasModel = input.hasModelChip ?? true;
  const hasSession = input.hasSessionChip ?? true;
  const layout = chatHeaderChipLayout({
    windowWidth: input.windowWidth,
    model: hasModel,
    session: hasSession,
  });
  const base = layout === 'stacked' ? CHAT_COMPOSER_KAV_BASE_STACKED : CHAT_COMPOSER_KAV_BASE_ROW;
  const inset = Number.isFinite(input.topInset) && input.topInset > 0 ? input.topInset : 0;
  return base + inset;
}
