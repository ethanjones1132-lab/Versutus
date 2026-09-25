/**
 * Base header chrome height on a phone, excluding the status-bar inset.
 *
 * The header is one row (chat-header-layout.ts) — back · title · one menu —
 * so it never grows a second row and the offset never has to clear one.
 * 72 = wrap (16) + card padding (16) + the tallest thing in the row, the
 * two-line title block, which rounds to the same 72 the pre-chip header used.
 */
export const CHAT_COMPOSER_KAV_BASE_ROW = 72;

/**
 * KeyboardAvoidingView vertical offset for the chat composer.
 *
 * iOS: the KAV's `padding` behavior must clear the navigation/status bar
 * (`topInset`) plus the header chrome. Android/web: KAV is not used
 * (ComposerKeyboardLift owns IME lift), so the offset is 0.
 */
export function chatComposerKeyboardOffset(input: {
  platform: string;
  topInset: number;
}): number {
  if (input.platform !== 'ios') return 0;
  const inset = Number.isFinite(input.topInset) && input.topInset > 0 ? input.topInset : 0;
  return CHAT_COMPOSER_KAV_BASE_ROW + inset;
}
