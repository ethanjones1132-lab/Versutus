// Palette list height — keeps the SectionList inside the sheet's shrunken
// maxHeight on a 640px phone with IME open.
//
// The palette lives inside BaseSheet whose ceiling is sheetMaxHeight().
// A fixed 380px list plus the search field exceeds that ceiling when the IME
// shrinks the sheet to ~300px, clipping the last section rows under the
// keyboard. Bounding the list to sheetMaxHeight minus chrome keeps it
// scrollable inside the sheet.

import { sheetMaxHeight } from './sheet-height';

export const PALETTE_LIST_MAX_HEIGHT = 380;
export const PALETTE_LIST_MIN_HEIGHT = 120;
// Header chrome inside the sheet that the list must leave room for:
// eyebrow row (~26) + title (~28) + search TextField (~48) + gaps/padding (~20) ≈ 122
// Use 116 as a conservative round that still leaves breathing room.
export const PALETTE_CHROME = 116;

export function paletteListMaxHeight(input: {
  windowHeight: number;
  insetTop?: number;
  insetBottom?: number;
  keyboardHeight?: number;
}): number {
  const { windowHeight, insetTop = 0, insetBottom = 0, keyboardHeight = 0 } = input;
  const sheet = sheetMaxHeight({
    windowHeight,
    insetTop,
    insetBottom,
    keyboardHeight,
  });
  const available = sheet - PALETTE_CHROME;
  // Clamp to [MIN, MAX] and to the sheet budget.
  const bounded = Math.min(PALETTE_LIST_MAX_HEIGHT, available);
  return Math.max(PALETTE_LIST_MIN_HEIGHT, Math.round(bounded));
}
