import type { SlashCommandSuggestion } from './slash-commands';

export type SlashCommandGroup = {
  family: string;
  items: SlashCommandSuggestion[];
};

/**
 * Families that earn a fixed position at the top of the palette. Everything
 * else sorts alphabetically underneath, so a gateway that contributes new
 * families does not reshuffle the rows a user has learned.
 */
const FAMILY_PRIORITY = ['Recent', 'Chat', 'Capability'];

/**
 * Filter palette rows by a free-text query.
 *
 * The leading slash is optional: the palette is usually opened by typing `/`,
 * so requiring it again would mean `//session` is the only way to search.
 * Returns the same reference for an empty query so callers can memoize cheaply.
 */
export function filterPaletteSuggestions(
  suggestions: readonly SlashCommandSuggestion[],
  query: string,
): readonly SlashCommandSuggestion[] {
  const needle = query.trim().replace(/^\/+/, '').toLowerCase();
  if (!needle) return suggestions;

  return suggestions.filter((item) => {
    const value = item.value.toLowerCase();
    const label = item.label.toLowerCase();
    const description = item.description.toLowerCase();
    const family = item.family.toLowerCase();
    return (
      value.includes(needle) ||
      label.includes(needle) ||
      description.includes(needle) ||
      family.includes(needle)
    );
  });
}

/**
 * Group rows by family, preserving each family's first-seen row order.
 *
 * Unavailable commands sink to the bottom of their own group for the same
 * reason they sink in the flat list — a command the gateway cannot run should
 * never be the first thing under a heading.
 */
export function groupSuggestionsByFamily(
  suggestions: readonly SlashCommandSuggestion[],
): SlashCommandGroup[] {
  const byFamily = new Map<string, SlashCommandSuggestion[]>();

  for (const item of suggestions) {
    const family = item.family || 'Other';
    const bucket = byFamily.get(family);
    if (bucket) bucket.push(item);
    else byFamily.set(family, [item]);
  }

  return [...byFamily.entries()]
    .map(([family, items]) => ({
      family,
      items: [...items].sort(
        (a, b) => Number(a.unavailable ?? false) - Number(b.unavailable ?? false),
      ),
    }))
    .sort((a, b) => {
      const ai = FAMILY_PRIORITY.indexOf(a.family);
      const bi = FAMILY_PRIORITY.indexOf(b.family);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return a.family.localeCompare(b.family);
    });
}
