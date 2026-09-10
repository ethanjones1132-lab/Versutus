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

import {
  BOT_VOICE_DEFAULT_LABEL,
  botVoiceOptions,
  botVoiceRows,
} from '@/lib/voice/bot-voices';

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
