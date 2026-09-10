// ─── Spoken replies: the voices this device can read a Bot's reply in ──────
// Solution B2 (`FUTURE-ITEMS.md:436-440`): "Bots have souls; give them
// voices. Persist `{ voiceIdentifier, rate, pitch }` per Bot in the bot chrome
// state ... Pick from `Speech.getAvailableVoicesAsync()`, prefer
// `VoiceQuality.Enhanced`."
//
// This is the PICKING half: the pure fold the picker's rows are drawn from.
// Nothing here names a package — the platform's answer is read structurally
// and every row is checked on its own terms, because the list is the
// platform's to shape and a row this device cannot be spoken with is not a
// choice. What is STORED is the shipped store's (`voice-preferences.ts`): the
// key, the fold onto one Bot and the normalization are those, and this module
// only decides what the operator is offered and which offer they already made.

/** The quality name the platform uses for a voice it calls Enhanced. */
const ENHANCED_QUALITY = 'Enhanced';

/**
 * The row that means "no voice chosen", so the platform's own defaults stand.
 * Wording from B2's own claim that a per-Bot voice is optional.
 */
export const BOT_VOICE_DEFAULT_LABEL = 'Default voice';

/** One voice this device offers, named the way the platform names it. */
export type BotVoiceRow = {
  identifier: string;
  label: string;
  /** Whether the platform calls this voice Enhanced (B2 prefers those). */
  enhanced: boolean;
};

/** One row the picker draws: a voice, or the platform's own default. */
export type BotVoiceOption = {
  /** The voice to store; absent on the row that means the platform's default. */
  identifier?: string;
  label: string;
  /** Whether this is the row this Bot is stored with. */
  selected: boolean;
};

/**
 * One voice off the platform's list, or undefined when it is not a voice this
 * device could be handed: a row with no identifier names nothing, and a name
 * the platform left blank is spoken by its identifier rather than by an
 * invented one.
 */
function botVoiceRow(value: unknown): BotVoiceRow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as { identifier?: unknown; name?: unknown; quality?: unknown };
  if (typeof entry.identifier !== 'string' || !entry.identifier.trim()) return undefined;
  const identifier = entry.identifier.trim();
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  return {
    identifier,
    label: name || identifier,
    enhanced: entry.quality === ENHANCED_QUALITY,
  };
}

/**
 * The voices the platform named, in the order the picker draws them: an
 * Enhanced voice first (B2's own preference), and within a tier the order the
 * platform gave. The tier is the only thing this fold reorders, so the sort is
 * this module's rule rather than a property of the engine's sort. A list that
 * is not a list answers nothing rather than guessing.
 */
export function botVoiceRows(voices: unknown): BotVoiceRow[] {
  if (!Array.isArray(voices)) return [];
  const rows: { row: BotVoiceRow; at: number }[] = [];
  voices.forEach((voice, at) => {
    const row = botVoiceRow(voice);
    if (row) rows.push({ row, at });
  });
  rows.sort((a, b) => Number(b.row.enhanced) - Number(a.row.enhanced) || a.at - b.at);
  return rows.map((entry) => entry.row);
}

/**
 * Every row the picker offers: the platform's own default first, then the
 * voices in `botVoiceRows`'s order, with the one this Bot is stored with
 * marked. A device the platform named no voice for is offered NOTHING — not a
 * lone "Default voice" — because there is no voice to choose between. A stored
 * identifier the platform no longer names leaves every row unselected: the
 * reply is still read in that voice if the device still has it, so no row may
 * claim to be it, and none may claim the default instead.
 */
export function botVoiceOptions(voices: unknown, storedVoiceIdentifier?: unknown): BotVoiceOption[] {
  const rows = botVoiceRows(voices);
  if (!rows.length) return [];
  const stored =
    typeof storedVoiceIdentifier === 'string' && storedVoiceIdentifier.trim()
      ? storedVoiceIdentifier.trim()
      : undefined;
  return [
    { label: BOT_VOICE_DEFAULT_LABEL, selected: stored === undefined },
    ...rows.map((row) => ({
      identifier: row.identifier,
      label: row.label,
      selected: row.identifier === stored,
    })),
  ];
}
