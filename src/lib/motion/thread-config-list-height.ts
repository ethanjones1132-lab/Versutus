// Thread config list height — keeps FlatList/SectionList inside the sheet's
// shrunken maxHeight on a 640px phone with IME open.
//
// The thread config sheet lives inside BaseSheet whose ceiling is
// sheetMaxHeight(). A list with only flexGrow:0 and no maxHeight grows to its
// content, exceeding the sheet budget when ~40 sessions or many model groups
// render (seen on session picker overflow). Bounding the list to
// sheetMaxHeight minus header/search chrome keeps it scrollable inside the
// sheet, matching the slash palette fix.

import { sheetMaxHeight } from './sheet-height';

export const THREAD_CONFIG_LIST_MAX_HEIGHT = 380;
export const THREAD_CONFIG_LIST_MIN_HEIGHT = 120;
// Chrome inside the sheet that the list must leave room for:
// eyebrow (~26) + title (~28) + switcher row (~32 + gap 8) + search/newRow
// TextField (~48 + margin) + gaps/padding (~20) ≈ 130. Use 120 as a
// conservative round that still leaves breathing room on 640+IME.
export const THREAD_CONFIG_CHROME = 120;

export function threadConfigListMaxHeight(input: {
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
  const available = sheet - THREAD_CONFIG_CHROME;
  const bounded = Math.min(THREAD_CONFIG_LIST_MAX_HEIGHT, available);
  return Math.max(THREAD_CONFIG_LIST_MIN_HEIGHT, Math.round(bounded));
}
