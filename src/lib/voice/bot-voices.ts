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
//
// The TUNING half rides the same entry. B2 persists `{ voiceIdentifier, rate,
// pitch }` per Bot, so the ladder the rate and pitch rows offer, the step a
// Bot stands at and the patch a tap writes are folds here too — and the copy
// under the rows states this ladder's own range, because the platform
// documents no bound for either field.

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

// ─── One Bot's voice, tuned: the rate and pitch rows under the picker ───────
/**
 * The platform's own normal for both rate and pitch — `SpeechOptions`
 * documents `1.0` as the normal for each — and the UNSET state of every row
 * here: a Bot left at normal stores no field at all, rather than a value the
 * platform would have used anyway.
 */
export const BOT_VOICE_NORMAL = 1;

/**
 * The values a refinement row offers, lowest first. The platform documents no
 * bound for either field, so this ladder IS the range this surface hands over
 * — and the copy under the rows states it rather than clamping a value from
 * somewhere else into it.
 */
export const BOT_VOICE_REFINEMENT_STEPS: readonly number[] = [0.5, 1, 1.5, 2];

/**
 * The one line the refinement rows carry: the range, stated. It names the
 * ladder's own ends and its normal, so the operator reads the bound this
 * surface will hand the platform instead of finding it at the ends.
 */
export const BOT_VOICE_RANGE_COPY = 'Rate and pitch: 0.5x to 2x, with 1x the normal the platform would use anyway.';

/** Which of a Bot's two refinements a row writes. */
export type BotVoiceRefinementField = 'rate' | 'pitch';

/** One step a refinement row offers. */
export type BotVoiceRefinementStep = {
  /** The value handed back when this step is tapped. */
  value: number;
  /** How the step reads: its own value, in this ladder's terms. */
  label: string;
  /** Whether this is the step the stored voice stands at. */
  selected: boolean;
};

/** One refinement row: the field it writes, what it is called, and its steps. */
export type BotVoiceRefinementRow = {
  field: BotVoiceRefinementField;
  label: string;
  steps: BotVoiceRefinementStep[];
};

/**
 * A patch onto one Bot's voice as this module can write one: a refinement,
 * never the voice itself. The store's own fold takes it (`applyBotVoice`),
 * which is what merges it with the voice already stored.
 */
export type BotVoiceRefinementPatch = {
  rate?: number;
  pitch?: number;
};

/**
 * The stored voice read structurally: this module imports nothing, so the
 * shape the store holds is spelled here rather than taken from it.
 */
type StoredBotVoice = {
  voiceIdentifier?: unknown;
  rate?: unknown;
  pitch?: unknown;
};

/** The two rows, in the order the chrome draws them, with what each is called. */
const REFINEMENT_ROWS: { field: BotVoiceRefinementField; label: string }[] = [
  { field: 'rate', label: 'Rate' },
  { field: 'pitch', label: 'Pitch' },
];

/** How one step reads: its own value as the multiplier the platform is handed. */
function refinementStepLabel(value: number): string {
  return `${value}x`;
}

/** One refinement out of a stored entry, or undefined when none is stored. */
function storedRefinement(stored: StoredBotVoice, field: BotVoiceRefinementField): number | undefined {
  const value = stored[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The rows the refinement control draws under the picker's chips, or none at
 * all where this Bot is stored with no voice: the store's entry IS a voice
 * with its refinements, so a Bot on the platform's own default has nothing to
 * tune here rather than a control that could not be written anywhere.
 *
 * The step a Bot stands at is marked. A field with nothing stored reads as the
 * platform's own normal, because that is exactly what stands; a stored value
 * this ladder does not hold — a hand-edited store, or one a later ladder wrote
 * — leaves every step unselected, because no step may claim a value it is not.
 */
export function botVoiceRefinementRows(stored: unknown): BotVoiceRefinementRow[] {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
  const entry = stored as StoredBotVoice;
  if (typeof entry.voiceIdentifier !== 'string' || !entry.voiceIdentifier.trim()) return [];
  return REFINEMENT_ROWS.map(({ field, label }) => {
    const standing = storedRefinement(entry, field) ?? BOT_VOICE_NORMAL;
    return {
      field,
      label,
      steps: BOT_VOICE_REFINEMENT_STEPS.map((value) => ({
        value,
        label: refinementStepLabel(value),
        selected: value === standing,
      })),
    };
  });
}

/**
 * The patch one refinement tap writes, or undefined for a value this ladder
 * does not hold — refused rather than clamped to a neighbour, because the
 * platform is handed what the operator chose and nothing else.
 *
 * The ladder's own normal is the UNSET state: it is written as an ABSENT
 * field, so a Bot put back to normal keeps its voice (and its other
 * refinement) rather than storing the value the platform would have used
 * anyway. Folded onto the entry, that is the store's own merge.
 */
export function botVoiceRefinementPatch(
  field: BotVoiceRefinementField,
  value: number,
): BotVoiceRefinementPatch | undefined {
  if (!BOT_VOICE_REFINEMENT_STEPS.includes(value)) return undefined;
  const patch: BotVoiceRefinementPatch = {};
  patch[field] = value === BOT_VOICE_NORMAL ? undefined : value;
  return patch;
}
