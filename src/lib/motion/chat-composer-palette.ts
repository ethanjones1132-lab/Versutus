// Chat composer inline slash palette height — keeps the inline list
// inside the available viewport on a 640px phone with IME open.
//
// The composer palette lives docked above the input Card, not inside a
// BaseSheet. A fixed 180/150 cap exceeds the viewport when the IME
// shrinks the window on a short phone, clipping the tail. Bounding it
// to the sheet ceiling (via paletteListMaxHeight) minus inline chrome
// keeps it scrollable while preserving the 180/150 caps on tall windows.

import { paletteListMaxHeight } from './slash-palette-height';

export const CHAT_COMPOSER_PALETTE_MAX_HEIGHT = 180;
export const CHAT_COMPOSER_PALETTE_SCROLL_MAX_HEIGHT = 150;
// Chrome inside the palette container that the scroll view must leave room for:
// title row (~18) + its top padding (~8) + container padding/gap (~8) ≈ 34.
// Use 30 as a tight round to avoid over-clamping.
export const CHAT_COMPOSER_PALETTE_CHROME = 30;
// Extra chrome delta for the inline dock (composer input + spacing) beyond the
// sheet-based paletteListMaxHeight; ensures 640+IME bounds below 180 even
// when paletteList sits at 182 on that viewport.
export const CHAT_COMPOSER_INLINE_OFFSET = 20;
// Smallest useful outer height; below this the list is not readable.
export const CHAT_COMPOSER_PALETTE_MIN_HEIGHT = 100;
// Smallest useful scroll height.
export const CHAT_COMPOSER_PALETTE_SCROLL_MIN_HEIGHT = 80;

export function chatComposerPaletteMaxHeight(input: {
  windowHeight: number;
  insetTop?: number;
  insetBottom?: number;
  keyboardHeight?: number;
}): number {
  const listCap = paletteListMaxHeight(input);
  const bounded = Math.min(CHAT_COMPOSER_PALETTE_MAX_HEIGHT, listCap - CHAT_COMPOSER_INLINE_OFFSET);
  return Math.max(CHAT_COMPOSER_PALETTE_MIN_HEIGHT, Math.round(bounded));
}

export function chatComposerPaletteScrollMaxHeight(input: {
  windowHeight: number;
  insetTop?: number;
  insetBottom?: number;
  keyboardHeight?: number;
}): number {
  const outer = chatComposerPaletteMaxHeight(input);
  const scroll = outer - CHAT_COMPOSER_PALETTE_CHROME;
  const bounded = Math.min(CHAT_COMPOSER_PALETTE_SCROLL_MAX_HEIGHT, scroll);
  return Math.max(CHAT_COMPOSER_PALETTE_SCROLL_MIN_HEIGHT, Math.round(bounded));
}
