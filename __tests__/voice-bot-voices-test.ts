// Solution B2's per-Bot voice PICKER (`FUTURE-ITEMS.md:436-440`): "Bots have
// souls; give them voices. Persist `{ voiceIdentifier, rate, pitch }` per Bot
// in the bot chrome state ... Pick from `Speech.getAvailableVoicesAsync()`,
// prefer `VoiceQuality.Enhanced`."
//
// This suite is the picking half only. `botVoiceRows` is the order the
// operator sees — a voice the platform calls `Enhanced` first, the platform's
// own order kept inside a tier — with every row checked on its own terms,
// because the list is the platform's to shape and a row nothing can be spoken
// with is not a choice. `botVoiceOptions` is the whole picker: the platform's
// own default first, the one already stored marked, and NO options at all for
// a device the platform named no voice for. What is stored is the shipped
// store's (`voice-preferences.ts`); nothing here writes.
//
// The tuning half is here too: `botVoiceRefinementRows` is the ladder the rate
// and pitch rows offer, with the step this Bot stands at marked and a field
// with nothing stored reading as the platform's own normal, and
// `botVoiceRefinementPatch` is what a tap writes — the normal as an ABSENT
// field rather than a stored one, and a value off the ladder refused rather
// than clamped to a neighbour.

import {
  BOT_VOICE_DEFAULT_LABEL,
  BOT_VOICE_NORMAL,
  BOT_VOICE_RANGE_COPY,
  BOT_VOICE_REFINEMENT_STEPS,
  botVoiceOptions,
  botVoiceRefinementPatch,
  botVoiceRefinementRows,
  botVoiceRows,
  type BotVoiceRefinementField,
} from '@/lib/voice/bot-voices';
import { applyBotVoice } from '@/lib/voice/voice-preferences';

// The refinement patch is folded by the STORE's own merge, so the store is
// reachable from this suite; its key-value seam is not read by a pure fold and
// is mocked out the way the store's own suite mocks it.
jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

/** One voice the way the platform hands it back. */
const voice = (identifier: string, quality: 'Default' | 'Enhanced' = 'Default', name?: string) => ({
  identifier,
  name: name ?? identifier,
  quality,
  language: 'en-US',
});

describe('the rows the voice picker draws', () => {
  test('an Enhanced voice is offered before a Default one', () => {
    const rows = botVoiceRows([
      voice('voice.default'),
      voice('voice.enhanced', 'Enhanced'),
    ]);

    expect(rows.map((row) => row.identifier)).toEqual(['voice.enhanced', 'voice.default']);
    expect(rows.map((row) => row.enhanced)).toEqual([true, false]);
  });

  test('the platform’s own order is kept inside a tier', () => {
    const rows = botVoiceRows([
      voice('voice.d1'),
      voice('voice.e1', 'Enhanced'),
      voice('voice.d2'),
      voice('voice.e2', 'Enhanced'),
    ]);

    // Enhanced first, in the platform's order; then Default, in the
    // platform's order. The tier is the only thing this fold reorders.
    expect(rows.map((row) => row.identifier)).toEqual([
      'voice.e1',
      'voice.e2',
      'voice.d1',
      'voice.d2',
    ]);
  });

  test('a row naming no voice is dropped rather than drawn', () => {
    const rows = botVoiceRows([
      voice('voice.kept'),
      { name: 'Nameless', quality: 'Enhanced', language: 'en-US' },
      { identifier: '', name: 'Blank', quality: 'Default', language: 'en-US' },
      { identifier: '   ', name: 'Whitespace', quality: 'Default', language: 'en-US' },
      { identifier: 42, name: 'Numbered', quality: 'Default', language: 'en-US' },
      { identifier: null, name: 'Null', quality: 'Default', language: 'en-US' },
      ['voice.array'],
      null,
      'voice.string',
      7,
    ]);

    // A voice is whatever the platform calls it, never a number, an object or
    // an array coerced into one — and a row with nothing to name is not a
    // choice the operator could make.
    expect(rows.map((row) => row.identifier)).toEqual(['voice.kept']);
  });

  test('an identifier is trimmed, and names the row when the platform names it nothing', () => {
    const rows = botVoiceRows([
      { identifier: '  voice.spaced  ', name: '  ', quality: 'Default', language: 'en-US' },
      { identifier: 'voice.plain', name: '  Samantha  ', quality: 'Default', language: 'en-US' },
    ]);

    expect(rows).toEqual([
      { identifier: 'voice.spaced', label: 'voice.spaced', enhanced: false },
      { identifier: 'voice.plain', label: 'Samantha', enhanced: false },
    ]);
  });

  test('a device that named no voice answers no rows', () => {
    expect(botVoiceRows([])).toEqual([]);
    // A list that is not a list is the same answer rather than a guess: the
    // seam hands the platform's own answer on unread.
    expect(botVoiceRows(undefined)).toEqual([]);
    expect(botVoiceRows(null)).toEqual([]);
    expect(botVoiceRows('voice.kept')).toEqual([]);
    expect(botVoiceRows({ 0: voice('voice.kept') })).toEqual([]);
  });
});

describe('the options the picker offers', () => {
  test('the platform’s own default is the first choice, and it is the one unconfigured means', () => {
    const options = botVoiceOptions([voice('voice.one')]);

    expect(options[0]).toEqual({
      label: BOT_VOICE_DEFAULT_LABEL,
      selected: true,
    });
    // The default row carries no identifier: choosing it stores no voice, so
    // the platform's own defaults stand — that is what it means.
    expect(options[0].identifier).toBeUndefined();
    expect(options.map((option) => option.label)).toEqual([BOT_VOICE_DEFAULT_LABEL, 'voice.one']);
    expect(options[1]).toEqual({ identifier: 'voice.one', label: 'voice.one', selected: false });
  });

  test('the stored voice is the selected row, and the default is not', () => {
    const options = botVoiceOptions([voice('voice.one'), voice('voice.two')], 'voice.two');

    expect(options.find((option) => option.selected)?.identifier).toBe('voice.two');
    expect(options[0].selected).toBe(false);
    expect(options.filter((option) => option.selected)).toHaveLength(1);
  });

  test('a stored voice the platform no longer names leaves every row unselected', () => {
    // An uninstalled enhanced voice is still what this Bot is stored with, so
    // no row may claim to be it — and none may claim the default instead.
    const options = botVoiceOptions([voice('voice.one')], 'voice.uninstalled');

    expect(options.some((option) => option.selected)).toBe(false);
  });

  test('a blank stored voice is no voice, so the default stands selected', () => {
    expect(botVoiceOptions([voice('voice.one')], '   ')[0].selected).toBe(true);
  });

  test('a device that named no voice offers no choice at all', () => {
    // Not a lone "Default voice": there is no voice to pick between, so the
    // surface is handed nothing to draw rather than a control that cannot
    // finish.
    expect(botVoiceOptions([], 'voice.one')).toEqual([]);
    expect(botVoiceOptions(undefined)).toEqual([]);
    expect(botVoiceOptions([{ name: 'Nameless' }])).toEqual([]);
  });

  test('the rows keep the fold’s own order', () => {
    const options = botVoiceOptions([
      voice('voice.default'),
      voice('voice.enhanced', 'Enhanced'),
    ]);

    expect(options.map((option) => option.identifier)).toEqual([
      undefined,
      'voice.enhanced',
      'voice.default',
    ]);
  });

  test('it is a pure fold: it reaches no package, no store and no gateway', () => {
    const source = readSource('src', 'lib', 'voice', 'bot-voices.ts');

    // The module is rules only — no import statements at all, so there is no
    // `expo-speech`, no key-value store and no `fetch(` to reach at runtime.
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toContain('expo-speech');
    expect(source).not.toContain('fetch(');
  });
});

describe('the steps a refinement row offers', () => {
  const stored = (extra: Record<string, unknown> = {}) => ({ voiceIdentifier: 'voice.one', ...extra });

  test('a Bot stored with no voice has nothing to refine', () => {
    // The store's entry IS a voice with its refinements, so a Bot on the
    // platform's own default is offered no row at all rather than a control
    // that could not be written anywhere.
    expect(botVoiceRefinementRows(undefined)).toEqual([]);
    expect(botVoiceRefinementRows({ rate: 1.5, pitch: 0.5 })).toEqual([]);
    expect(botVoiceRefinementRows({ voiceIdentifier: '' })).toEqual([]);
    expect(botVoiceRefinementRows({ voiceIdentifier: '   ' })).toEqual([]);
    expect(botVoiceRefinementRows({ voiceIdentifier: 42 })).toEqual([]);
    expect(botVoiceRefinementRows(null)).toEqual([]);
    expect(botVoiceRefinementRows('voice.one')).toEqual([]);
  });

  test('both rows offer this module’s own ladder, in its own order', () => {
    const rows = botVoiceRefinementRows(stored());

    expect(rows.map((row) => row.field)).toEqual(['rate', 'pitch']);
    expect(rows.map((row) => row.label)).toEqual(['Rate', 'Pitch']);
    expect(rows.map((row) => row.steps.map((step) => step.value))).toEqual([
      [...BOT_VOICE_REFINEMENT_STEPS],
      [...BOT_VOICE_REFINEMENT_STEPS],
    ]);
    // A step reads as its own value, so the surface has no number to spell.
    expect(rows[0].steps.map((step) => step.label)).toEqual(['0.5x', '1x', '1.5x', '2x']);
  });

  test('a field with nothing stored reads as the platform’s own normal', () => {
    const rows = botVoiceRefinementRows(stored());

    // What stands when no rate and no pitch is stored IS the platform's
    // normal, so that step is the one marked — and only it.
    for (const row of rows) {
      expect(row.steps.filter((step) => step.selected).map((step) => step.value)).toEqual([
        BOT_VOICE_NORMAL,
      ]);
    }
  });

  test('the stored refinement is the step this Bot stands at, the two read apart', () => {
    const rows = botVoiceRefinementRows(stored({ rate: 1.5, pitch: 0.5 }));

    expect(rows[0].steps.find((step) => step.selected)?.value).toBe(1.5);
    expect(rows[1].steps.find((step) => step.selected)?.value).toBe(0.5);
    expect(rows[0].steps.filter((step) => step.selected)).toHaveLength(1);
    expect(rows[1].steps.filter((step) => step.selected)).toHaveLength(1);
  });

  test('a stored value this ladder does not hold leaves every step unselected', () => {
    const rows = botVoiceRefinementRows(stored({ rate: 1.25 }));

    // No step may claim a rate it is not — not even the normal, which is not
    // what this device would hand the platform.
    expect(rows[0].steps.some((step) => step.selected)).toBe(false);
    // The field with nothing stored is untouched by its neighbour's junk.
    expect(rows[1].steps.find((step) => step.selected)?.value).toBe(BOT_VOICE_NORMAL);
  });

  test('a refinement that is not a finite number reads as nothing stored', () => {
    const rows = botVoiceRefinementRows(stored({ rate: '1.5', pitch: Number.NaN }));

    expect(rows[0].steps.find((step) => step.selected)?.value).toBe(BOT_VOICE_NORMAL);
    expect(rows[1].steps.find((step) => step.selected)?.value).toBe(BOT_VOICE_NORMAL);
  });

  test('the copy under the rows states the range the ladder offers', () => {
    // The platform documents no bound for either field — only that one is
    // normal — so this ladder IS the range, and the line says so rather than
    // leaving the ends to be found by dragging into them.
    const [low, ...rest] = BOT_VOICE_REFINEMENT_STEPS;
    const high = rest[rest.length - 1];

    expect(BOT_VOICE_RANGE_COPY).toContain(`${low}x`);
    expect(BOT_VOICE_RANGE_COPY).toContain(`${high}x`);
    expect(BOT_VOICE_RANGE_COPY).toContain(`${BOT_VOICE_NORMAL}x`);
  });
});

describe('the patch a refinement tap writes', () => {
  const key = 'voice:gw-1:bot-1';
  const storedEntry = { voiceIdentifier: 'voice.one', rate: 1.5, pitch: 0.5 };

  /** The entry after one refinement, or a failure if the fold refused a step it offers. */
  function entryAfter(field: BotVoiceRefinementField, value: number) {
    const patch = botVoiceRefinementPatch(field, value);
    if (!patch) throw new Error(`the fold refused ${field} ${value}`);
    return applyBotVoice({ [key]: storedEntry }, key, patch)[key];
  }

  test('the ladder’s own normal is the unset state: the field is dropped, not stored at one', () => {
    expect(botVoiceRefinementPatch('rate', BOT_VOICE_NORMAL)).toStrictEqual({ rate: undefined });
    expect(botVoiceRefinementPatch('pitch', BOT_VOICE_NORMAL)).toStrictEqual({ pitch: undefined });

    // Folded onto the entry it drops exactly that field, so the platform's own
    // normal stands — and the voice and the other refinement are kept.
    expect(entryAfter('rate', BOT_VOICE_NORMAL)).toStrictEqual({
      voiceIdentifier: 'voice.one',
      pitch: 0.5,
    });
    expect(entryAfter('pitch', BOT_VOICE_NORMAL)).toStrictEqual({
      voiceIdentifier: 'voice.one',
      rate: 1.5,
    });
  });

  test('a step is written as the value it carries', () => {
    expect(botVoiceRefinementPatch('rate', 0.5)).toStrictEqual({ rate: 0.5 });
    expect(botVoiceRefinementPatch('pitch', 2)).toStrictEqual({ pitch: 2 });

    expect(entryAfter('rate', 2)).toStrictEqual({
      voiceIdentifier: 'voice.one',
      rate: 2,
      pitch: 0.5,
    });
    expect(entryAfter('pitch', 0.5)).toStrictEqual({
      voiceIdentifier: 'voice.one',
      rate: 1.5,
      pitch: 0.5,
    });
  });

  test('a value this ladder does not hold is refused rather than clamped to a neighbour', () => {
    expect(botVoiceRefinementPatch('rate', 5)).toBeUndefined();
    expect(botVoiceRefinementPatch('rate', 0)).toBeUndefined();
    expect(botVoiceRefinementPatch('rate', 1.25)).toBeUndefined();
    expect(botVoiceRefinementPatch('pitch', Number.NaN)).toBeUndefined();
    expect(botVoiceRefinementPatch('pitch', Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
