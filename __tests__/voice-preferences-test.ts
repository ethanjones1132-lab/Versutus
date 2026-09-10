// Solution B2's voice preferences (`FUTURE-ITEMS.md:431-440`): the speaker is
// an opt-in of ONE conversation — "when on, each completed assistant message
// is spoken" — and each Bot keeps its own voice. Both are this device's, so
// both live in one key-value blob, in two key spaces told apart by their key
// prefix: a conversation's toggle and a Bot's voice can never be read as each
// other, whatever an operator's ids look like.
//
// The honesty rules this suite pins: a toggle is OFF unless the stored value
// is exactly `true`, an entry that does not name a voice reads as no voice
// configured rather than a guessed identifier, and persistence is best-effort
// so a refused write never breaks the header the toggle is drawn in.

import { keyValueStorage } from '@/lib/storage/key-value';
import { composerDraftKey, type ComposerDraftThread } from '@/lib/gateway/composer-draft';
import {
  applyBotVoice,
  applySpeakerOn,
  botVoicePreferenceKey,
  clearVoicePreference,
  loadVoicePreferences,
  readBotVoice,
  readSpeakerOn,
  saveVoicePreferences,
  speakerPreferenceKey,
  voicePreferencesFromUnknown,
  VOICE_PREFERENCES_STORAGE_KEY,
  type BotVoice,
  type VoicePreferences,
} from '@/lib/voice/voice-preferences';

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

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;

const GATE = 'gw-home';
const OTHER_GATE = 'gw-other';

/** The Bot Chat on a Bot: the thread whose speaker flag B2's toggle reads. */
const BOT_CHAT: ComposerDraftThread = {
  gatewayId: GATE,
  surface: { kind: 'bot', botId: 'researcher' },
  sessionId: 'ses_crew',
};

/** Another session on the same Bot — its own conversation, its own toggle. */
const BOT_OTHER_SESSION: ComposerDraftThread = {
  gatewayId: GATE,
  surface: { kind: 'bot', botId: 'researcher' },
  sessionId: 'ses_lab',
};

/** Configurable chat: the roster's first row, a conversation like any other. */
const CONFIGURABLE_CHAT: ComposerDraftThread = {
  gatewayId: GATE,
  surface: { kind: 'configurable' },
  sessionId: 'ses_crew',
};

const VOICE_KEY = botVoicePreferenceKey(GATE, 'researcher');

const CHOSEN_VOICE: BotVoice = {
  voiceIdentifier: 'com.apple.voice.enhanced.en-US.Evan',
  rate: 0.95,
  pitch: 1,
};

describe('the two key spaces', () => {
  test("a conversation's key is the draft's own key under its own prefix", () => {
    // The composer keys its drafts by gateway + surface + session so two
    // threads cannot share one draft; the speaker is an opt-in of exactly that
    // thread, so it is the same key — built by the shipped fold rather than a
    // second copy of the rule — with the prefix that names its space.
    expect(speakerPreferenceKey(BOT_CHAT)).toBe('speaker:gw-home:bot:researcher:ses_crew');
    expect(speakerPreferenceKey(CONFIGURABLE_CHAT)).toBe('speaker:gw-home:configurable:ses_crew');
    expect(speakerPreferenceKey(BOT_CHAT)).toBe(`speaker:${composerDraftKey(BOT_CHAT)}`);
  });

  test("a Bot's voice key names the gateway the Bot lives on and the Bot", () => {
    expect(botVoicePreferenceKey(GATE, 'researcher')).toBe('voice:gw-home:researcher');
  });

  test('no conversation key can land in the Bot-voice space, or the other way round', () => {
    // The two spaces share one blob, so a Bot whose id happened to look like
    // part of a conversation key would be the one way a voice could be read as
    // a toggle. They cannot: each space's key carries its own prefix first.
    const threads = [
      BOT_CHAT,
      BOT_OTHER_SESSION,
      CONFIGURABLE_CHAT,
      { gatewayId: GATE, surface: { kind: 'bot', botId: 'configurable' }, sessionId: 'voice' },
    ] satisfies ComposerDraftThread[];

    for (const thread of threads) {
      const speaker = speakerPreferenceKey(thread);
      expect(speaker.startsWith('speaker:')).toBe(true);
      expect(speaker.startsWith('voice:')).toBe(false);
      for (const botId of ['researcher', 'configurable', 'ses_crew', '']) {
        for (const gatewayId of [GATE, OTHER_GATE]) {
          const voice = botVoicePreferenceKey(gatewayId, botId);
          expect(voice.startsWith('voice:')).toBe(true);
          expect(voice).not.toBe(speaker);
        }
      }
    }
  });

  test('two sessions on one Bot do not share a toggle', () => {
    expect(speakerPreferenceKey(BOT_CHAT)).not.toBe(speakerPreferenceKey(BOT_OTHER_SESSION));
  });

  test('two Bots on one gateway do not share a toggle', () => {
    const otherBot: ComposerDraftThread = {
      gatewayId: GATE,
      surface: { kind: 'bot', botId: 'coder' },
      sessionId: 'ses_crew',
    };
    expect(speakerPreferenceKey(BOT_CHAT)).not.toBe(speakerPreferenceKey(otherBot));
  });

  test("configurable chat and a Bot's chat do not share a toggle", () => {
    expect(speakerPreferenceKey(CONFIGURABLE_CHAT)).not.toBe(speakerPreferenceKey(BOT_CHAT));
  });

  test('the same session id on two gateways does not share a toggle', () => {
    const elsewhere: ComposerDraftThread = { ...BOT_CHAT, gatewayId: OTHER_GATE };
    expect(speakerPreferenceKey(elsewhere)).not.toBe(speakerPreferenceKey(BOT_CHAT));
  });

  test("one Bot's voice is not another gateway's Bot of the same name", () => {
    expect(botVoicePreferenceKey(OTHER_GATE, 'researcher')).not.toBe(VOICE_KEY);
  });
});

describe('the conversation speaker toggle', () => {
  const KEY = speakerPreferenceKey(BOT_CHAT);

  test('a conversation the store never saw reads off', () => {
    // B2 is an OPT-IN: a device that has never turned the speaker on speaks
    // nothing, and a store holding another thread's flag does not turn this one
    // on.
    expect(readSpeakerOn({}, KEY)).toBe(false);
    expect(readSpeakerOn({ [speakerPreferenceKey(BOT_OTHER_SESSION)]: true }, KEY)).toBe(false);
  });

  test('only a stored `true` is on', () => {
    // Anything else — a string, a number, an object, an explicit false — is not
    // the one value that means on, so it reads off rather than guessed at.
    for (const value of ['true', 1, 0, false, {}, [], null, undefined, { enabled: true }]) {
      expect(readSpeakerOn({ [KEY]: value } as unknown as VoicePreferences, KEY)).toBe(false);
    }
    expect(readSpeakerOn({ [KEY]: true }, KEY)).toBe(true);
  });

  test('turning the speaker on stores exactly `true`', () => {
    expect(applySpeakerOn({}, KEY, true)).toEqual({ [KEY]: true });
  });

  test('turning it off drops the key rather than storing a false', () => {
    // The store keeps only what is true: a stored `false` would be an entry
    // every read has to un-say, and the sibling label store drops a key that
    // carries nothing for the same reason.
    expect(applySpeakerOn({ [KEY]: true }, KEY, false)).toEqual({});
  });

  test('turning off a conversation that stores nothing returns the same map', () => {
    const preferences: VoicePreferences = { [VOICE_KEY]: CHOSEN_VOICE };
    expect(applySpeakerOn(preferences, KEY, false)).toBe(preferences);
  });

  test('turning on a conversation that is already on returns the same map', () => {
    const preferences = applySpeakerOn({}, KEY, true);
    expect(applySpeakerOn(preferences, KEY, true)).toBe(preferences);
  });

  test('one conversation being turned on leaves another conversation alone', () => {
    // The Bot Chat and another session of the same Bot are different
    // conversations: turning the speaker on in one must not speak the other.
    const other = speakerPreferenceKey(BOT_OTHER_SESSION);
    const preferences = applySpeakerOn({}, KEY, true);
    expect(readSpeakerOn(preferences, other)).toBe(false);
    expect(preferences[other]).toBeUndefined();
  });

  test("a Bot's voice stored in the same blob is not a toggle", () => {
    expect(readSpeakerOn({ [VOICE_KEY]: CHOSEN_VOICE }, KEY)).toBe(false);
    expect(readSpeakerOn({ [VOICE_KEY]: CHOSEN_VOICE }, VOICE_KEY)).toBe(false);
  });

  test('it does not mutate the map it was given', () => {
    const before: VoicePreferences = {};
    applySpeakerOn(before, KEY, true);
    expect(before).toEqual({});
  });
});

describe("a Bot's own voice", () => {
  test('a Bot with no stored voice reads as no voice configured', () => {
    expect(readBotVoice({}, VOICE_KEY)).toBeUndefined();
    expect(readBotVoice({ [speakerPreferenceKey(BOT_CHAT)]: true }, VOICE_KEY)).toBeUndefined();
  });

  test('a chosen voice lands with its identifier, rate and pitch', () => {
    expect(applyBotVoice({}, VOICE_KEY, CHOSEN_VOICE)).toEqual({ [VOICE_KEY]: CHOSEN_VOICE });
    expect(readBotVoice({ [VOICE_KEY]: CHOSEN_VOICE }, VOICE_KEY)).toEqual(CHOSEN_VOICE);
  });

  test('a voice can be chosen without overstepping the platform defaults', () => {
    const preferences = applyBotVoice({}, VOICE_KEY, { voiceIdentifier: 'voice.evan' });
    expect(preferences).toEqual({ [VOICE_KEY]: { voiceIdentifier: 'voice.evan' } });
  });

  test('a later patch merges — a rate keeps the voice already chosen', () => {
    let preferences = applyBotVoice({}, VOICE_KEY, { voiceIdentifier: 'voice.evan' });
    preferences = applyBotVoice(preferences, VOICE_KEY, { rate: 0.5 });
    expect(preferences[VOICE_KEY]).toEqual({ voiceIdentifier: 'voice.evan', rate: 0.5 });
    preferences = applyBotVoice(preferences, VOICE_KEY, { pitch: 1.2 });
    expect(preferences[VOICE_KEY]).toEqual({ voiceIdentifier: 'voice.evan', rate: 0.5, pitch: 1.2 });
  });

  test('a patch that names no voice stores nothing at all', () => {
    // A rate on its own is not a voice: nothing would know which voice to set
    // it on, so the patch is dropped rather than kept as a half entry.
    expect(applyBotVoice({}, VOICE_KEY, {})).toEqual({});
    expect(applyBotVoice({}, VOICE_KEY, { rate: 0.5 })).toEqual({});
    expect(applyBotVoice({}, VOICE_KEY, { voiceIdentifier: '   ' })).toEqual({});
  });

  test('clearing a voice that is stored drops the key', () => {
    let preferences = applyBotVoice({}, VOICE_KEY, CHOSEN_VOICE);
    preferences = applyBotVoice(preferences, VOICE_KEY, { voiceIdentifier: '' });
    expect(preferences[VOICE_KEY]).toBeUndefined();
    expect(preferences).toEqual({});
  });

  test("one Bot's voice leaves another Bot's alone", () => {
    const coder = botVoicePreferenceKey(GATE, 'coder');
    const preferences = applyBotVoice({}, VOICE_KEY, CHOSEN_VOICE);
    expect(preferences[coder]).toBeUndefined();
    expect(readBotVoice(preferences, coder)).toBeUndefined();
  });

  test('a stored voice is trimmed of surrounding whitespace but not re-worded', () => {
    const preferences = applyBotVoice({}, VOICE_KEY, { voiceIdentifier: '  voice.evan  ' });
    expect(preferences[VOICE_KEY]).toEqual({ voiceIdentifier: 'voice.evan' });
  });

  test('a junk rate or pitch is dropped and the voice is kept', () => {
    // The identifier is the voice; a rate the platform could not be handed is
    // not one, so it reads as no rate rather than as `NaN` speech.
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      const preferences = applyBotVoice({}, VOICE_KEY, {
        voiceIdentifier: 'voice.evan',
        rate: junk as unknown as number,
        pitch: junk as unknown as number,
      });
      expect(preferences[VOICE_KEY]).toEqual({ voiceIdentifier: 'voice.evan' });
    }
  });

  test('it does not mutate the map it was given', () => {
    const before: VoicePreferences = {};
    applyBotVoice(before, VOICE_KEY, CHOSEN_VOICE);
    expect(before).toEqual({});
  });
});

describe('clearVoicePreference', () => {
  test('drops either space', () => {
    const both: VoicePreferences = {
      [VOICE_KEY]: CHOSEN_VOICE,
      [speakerPreferenceKey(BOT_CHAT)]: true,
    };
    expect(clearVoicePreference(both, VOICE_KEY)).toEqual({ [speakerPreferenceKey(BOT_CHAT)]: true });
    expect(clearVoicePreference(both, speakerPreferenceKey(BOT_CHAT))).toEqual({
      [VOICE_KEY]: CHOSEN_VOICE,
    });
  });

  test('a key that stores nothing is returned untouched', () => {
    const preferences: VoicePreferences = { [VOICE_KEY]: CHOSEN_VOICE };
    expect(clearVoicePreference(preferences, 'speaker:gw-home:bot:ghost:s')).toBe(preferences);
  });

  test('does not mutate the map it was given', () => {
    const before: VoicePreferences = { [VOICE_KEY]: CHOSEN_VOICE };
    clearVoicePreference(before, VOICE_KEY);
    expect(before).toEqual({ [VOICE_KEY]: CHOSEN_VOICE });
  });
});

describe('voicePreferencesFromUnknown', () => {
  const KEY = speakerPreferenceKey(BOT_CHAT);

  test('a well-formed blob is read back field by field', () => {
    expect(
      voicePreferencesFromUnknown({ [KEY]: true, [VOICE_KEY]: CHOSEN_VOICE }),
    ).toEqual({ [KEY]: true, [VOICE_KEY]: CHOSEN_VOICE });
  });

  test('a non-record reads as nothing stored at all', () => {
    expect(voicePreferencesFromUnknown(undefined)).toEqual({});
    expect(voicePreferencesFromUnknown(null)).toEqual({});
    expect(voicePreferencesFromUnknown('{"a":1}')).toEqual({});
    expect(voicePreferencesFromUnknown(7)).toEqual({});
    expect(voicePreferencesFromUnknown(true)).toEqual({});
    expect(voicePreferencesFromUnknown([{ [KEY]: true }])).toEqual({});
  });

  test('a toggle that is not exactly true is dropped, not read as a voice', () => {
    // The key says which space an entry is in, so an object under a
    // conversation's key is a wrong-shaped toggle rather than a Bot's voice.
    expect(voicePreferencesFromUnknown({ [KEY]: { voiceIdentifier: 'voice.evan' } })).toEqual({});
    expect(voicePreferencesFromUnknown({ [KEY]: 'on' })).toEqual({});
    expect(voicePreferencesFromUnknown({ [KEY]: false })).toEqual({});
  });

  test('a value in the Bot space that names no voice is dropped', () => {
    expect(voicePreferencesFromUnknown({ [VOICE_KEY]: true })).toEqual({});
    expect(voicePreferencesFromUnknown({ [VOICE_KEY]: { rate: 0.5 } })).toEqual({});
    expect(voicePreferencesFromUnknown({ [VOICE_KEY]: { voiceIdentifier: 7 } })).toEqual({});
    expect(voicePreferencesFromUnknown({ [VOICE_KEY]: { voiceIdentifier: '   ' } })).toEqual({});
    expect(voicePreferencesFromUnknown({ [VOICE_KEY]: null })).toEqual({});
    expect(voicePreferencesFromUnknown({ [VOICE_KEY]: 'voice.evan' })).toEqual({});
  });

  test('an entry in neither key space is dropped rather than guessed', () => {
    expect(voicePreferencesFromUnknown({ 'composer-draft:gw-home:bot:r:s': 'text' })).toEqual({});
    expect(voicePreferencesFromUnknown({ hello: true })).toEqual({});
  });

  test('a good entry beside a junk one keeps only the good one', () => {
    expect(
      voicePreferencesFromUnknown({
        [KEY]: true,
        [VOICE_KEY]: { voiceIdentifier: 42 },
        junk: 'nope',
      }),
    ).toEqual({ [KEY]: true });
  });

  test('a junk rate underneath a named voice is dropped, the voice kept', () => {
    expect(
      voicePreferencesFromUnknown({ [VOICE_KEY]: { voiceIdentifier: 'voice.evan', rate: 'fast' } }),
    ).toEqual({ [VOICE_KEY]: { voiceIdentifier: 'voice.evan' } });
  });
});

describe('loadVoicePreferences / saveVoicePreferences', () => {
  const backing = new Map<string, string>();
  const KEY = speakerPreferenceKey(BOT_CHAT);

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
  });

  test('both spaces are one blob, under one key', async () => {
    await saveVoicePreferences({ [KEY]: true, [VOICE_KEY]: CHOSEN_VOICE });
    expect(mockSet.mock.calls[0]?.[0]).toBe(VOICE_PREFERENCES_STORAGE_KEY);
    expect(VOICE_PREFERENCES_STORAGE_KEY).toBe('versutus:voice-preferences');
  });

  test('what was saved is what you get back after leaving the conversation', async () => {
    const preferences = applyBotVoice(applySpeakerOn({}, KEY, true), VOICE_KEY, CHOSEN_VOICE);
    await saveVoicePreferences(preferences);
    await expect(loadVoicePreferences()).resolves.toEqual(preferences);
  });

  test('a missing blob loads as empty, not as a failure', async () => {
    await expect(loadVoicePreferences()).resolves.toEqual({});
  });

  test('malformed storage loads as empty, not a throw', async () => {
    backing.set(VOICE_PREFERENCES_STORAGE_KEY, '{not-json');
    await expect(loadVoicePreferences()).resolves.toEqual({});
  });

  test('a blob holding junk entries keeps only the honest ones', async () => {
    backing.set(
      VOICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ [KEY]: true, [VOICE_KEY]: { voiceIdentifier: 42 }, hello: 'there' }),
    );
    await expect(loadVoicePreferences()).resolves.toEqual({ [KEY]: true });
  });

  test('a refused write does not throw and answers nothing', async () => {
    // Best-effort, like the draft and the labels: the toggle's surface must
    // keep working on a device whose storage said no.
    mockSet.mockRejectedValue(new Error('disk full'));
    await expect(
      saveVoicePreferences({ [KEY]: true, [VOICE_KEY]: CHOSEN_VOICE }),
    ).resolves.toBeUndefined();
  });

  test('a refused read does not throw — an unread preference is nothing stored', async () => {
    mockGet.mockRejectedValue(new Error('disk full'));
    await expect(loadVoicePreferences()).resolves.toEqual({});
  });
});

describe('a voice preference never leaves the device', () => {
  const source = () => readSource('src', 'lib', 'voice', 'voice-preferences.ts');

  test('the module reaches no gateway and makes no request', () => {
    const src = source();
    expect(src).not.toContain('fetch(');
    const imports = src.match(/^import .*$/gm) ?? [];
    const values = imports.filter((line) => !line.startsWith('import type '));
    expect(values).toHaveLength(2);
    expect(values.join('\n')).toContain("from '@/lib/storage/key-value'");
    expect(values.join('\n')).toContain("from '@/lib/gateway/composer-draft'");
  });

  test("the conversation key is the shipped draft rule, not a second copy", () => {
    const src = source();
    expect(src).toContain('composerDraftKey(');
    expect(src).not.toContain("':bot:'");
    expect(src).not.toContain("':configurable:'");
  });

  test('the module names no recognizer and no speech engine — it is storage only', () => {
    expect(source()).not.toMatch(/expo-speech|recognition/);
  });
});
