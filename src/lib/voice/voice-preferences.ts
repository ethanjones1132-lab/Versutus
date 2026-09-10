// ─── Spoken replies: one conversation's toggle, one Bot's voice ───────────
// Solution B2 (`FUTURE-ITEMS.md:431-440`): the speaker is an opt-in of ONE
// conversation — "when on, each completed assistant message is spoken" — and
// "Bots have souls; give them voices", so each Bot keeps its own. Neither the
// toggle nor the voice can leave the phone: no gateway route carries either,
// so both are THIS device's, held in key-value storage the way a session's pin
// and name are.
//
// They live in one blob in key spaces told apart by the key's own prefix: a
// conversation's key is the composer-draft key under `speaker:`, a Bot's is
// its gateway and id under `voice:`. So a voice can never be read as a toggle,
// whatever ids a gateway hands back. The one-time silent-mode hint B2 asks to
// surface honestly (`:441-442`) keeps its acknowledgement in the same blob
// under its own prefix — a fact about the DEVICE rather than about a thread,
// so unlike the two above it is one entry rather than one per conversation.
//
// The fold rules are the honesty rules: a toggle is OFF unless the stored value
// is exactly `true`, an entry that does not name a voice reads as no voice
// configured rather than a guessed identifier, only a platform that HAS the
// caveat is ever owed the hint, and persistence is best-effort — a refused
// write must never break the header the toggle is drawn in.

import { composerDraftKey, type ComposerDraftThread } from '@/lib/gateway/composer-draft';
import { keyValueStorage } from '@/lib/storage/key-value';

/** The one key both spaces are held under. */
export const VOICE_PREFERENCES_STORAGE_KEY = 'versutus:voice-preferences';

/**
 * The key-space prefixes, written once so no space can drift into another: a
 * conversation's toggle, a Bot's voice, and this device's one-time
 * silent-mode acknowledgement share one blob.
 */
const SPEAKER_KEY_PREFIX = 'speaker:';
const VOICE_KEY_PREFIX = 'voice:';
const SILENT_HINT_KEY_PREFIX = 'silent-hint:';

/**
 * The one key the silent-mode acknowledgement is stored under. The caveat is a
 * fact about this DEVICE — whether it has been told that a silenced iPhone
 * makes no sound — so it is stored once rather than per conversation.
 */
const SILENT_HINT_ACKNOWLEDGED_KEY = `${SILENT_HINT_KEY_PREFIX}acknowledged`;

/**
 * The operator's voice for one Bot. The identifier is the voice itself, named
 * the way the platform names it (`Speech.getAvailableVoicesAsync()`); rate and
 * pitch refine how it speaks and are absent until the operator sets them, so
 * the platform's own defaults stand rather than being guessed here.
 */
export type BotVoice = {
  voiceIdentifier: string;
  rate?: number;
  pitch?: number;
};

/** A patch onto one Bot's voice: any field may be left out. */
export type BotVoicePatch = Partial<BotVoice>;

/**
 * The stored blob: one flat record over three key spaces. A conversation's
 * entry is the literal `true` — the speaker is on — a Bot's is its voice, and
 * this device's own acknowledgement of the silent-mode hint is the literal
 * `true` too, under its own prefix. Anything else a blob might hold is dropped
 * on read rather than guessed at.
 */
export type VoicePreferences = Record<string, true | BotVoice>;

/**
 * The key one conversation's speaker flag is stored under. The conversation is
 * the SAME thread the composer keeps its draft by — gateway + surface + session
 * — so two threads cannot share one toggle, and the rule is the shipped
 * `composerDraftKey`'s rather than a second copy of it.
 */
export function speakerPreferenceKey(thread: ComposerDraftThread): string {
  return `${SPEAKER_KEY_PREFIX}${composerDraftKey(thread)}`;
}

/**
 * The key one Bot's voice is stored under: the gateway the Bot lives on, plus
 * its own id, so the same Bot name on two gateways is two voices.
 */
export function botVoicePreferenceKey(gatewayId: string, botId: string): string {
  return `${VOICE_KEY_PREFIX}${gatewayId}:${botId}`;
}

/**
 * One Bot's voice, or undefined when the entry does not name one. Exactly the
 * three fields are read, each on its own terms: the identifier must be a
 * non-blank string — a voice is whatever the platform calls it, never a number
 * or an object coerced into one — and a rate or pitch the platform could not be
 * handed (not a finite number) is dropped rather than spoken with.
 */
function normalizeBotVoice(value: unknown): BotVoice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as BotVoice;
  if (typeof entry.voiceIdentifier !== 'string' || !entry.voiceIdentifier.trim()) return undefined;
  const voice: BotVoice = { voiceIdentifier: entry.voiceIdentifier.trim() };
  if (typeof entry.rate === 'number' && Number.isFinite(entry.rate)) voice.rate = entry.rate;
  if (typeof entry.pitch === 'number' && Number.isFinite(entry.pitch)) voice.pitch = entry.pitch;
  return voice;
}

/**
 * Whether this conversation's speaker is on. OFF unless the stored value is
 * exactly `true`, so a truncated write, a hand-edited store or a payload from
 * an older shape can only ever lose a toggle, never invent one.
 */
export function readSpeakerOn(preferences: VoicePreferences, key: string): boolean {
  return preferences[key] === true;
}

/**
 * One Bot's stored voice, or undefined when none is configured — which is not
 * the same as a voice speaking with the platform's defaults: nothing here knows
 * what those are, so the honest answer is that none was chosen.
 */
export function readBotVoice(preferences: VoicePreferences, key: string): BotVoice | undefined {
  return normalizeBotVoice(preferences[key]);
}

/** Drop one entry from either space. A key that stores nothing is untouched. */
export function clearVoicePreference(
  preferences: VoicePreferences,
  key: string,
): VoicePreferences {
  if (!(key in preferences)) return preferences;
  const next = { ...preferences };
  delete next[key];
  return next;
}

/**
 * Turn one conversation's speaker on or off. Turning it off drops the key
 * rather than storing a `false` — the store keeps only what is true, so no read
 * has to un-say an entry — and the flag stays that conversation's: another
 * thread's toggle is left exactly as it was.
 */
export function applySpeakerOn(
  preferences: VoicePreferences,
  key: string,
  on: boolean,
): VoicePreferences {
  if (!on) return clearVoicePreference(preferences, key);
  if (preferences[key] === true) return preferences;
  return { ...preferences, [key]: true };
}

/**
 * Fold a patch onto one Bot's voice: the three fields merge, so choosing a rate
 * keeps the voice already chosen and choosing a voice keeps the rate. A patch
 * that leaves the entry naming no voice drops the key entirely — that is how a
 * voice is cleared, rather than storing a row nothing could speak with.
 */
export function applyBotVoice(
  preferences: VoicePreferences,
  key: string,
  patch: BotVoicePatch,
): VoicePreferences {
  const stored = preferences[key];
  const base = stored && typeof stored === 'object' ? stored : {};
  const next = normalizeBotVoice({ ...base, ...patch });
  if (!next) return clearVoicePreference(preferences, key);
  return { ...preferences, [key]: next };
}

/**
 * The one line the silent-mode hint says. B2 asks for this caveat to be
 * surfaced honestly in the UI (`FUTURE-ITEMS.md:441-442`): a silenced iPhone
 * makes no sound, so a reply handed to the platform is inaudible rather than
 * refused. It is a hint and not an error, so it states what the device does
 * and claims nothing about what the operator heard — nothing on this side can
 * know that, and this module is storage only.
 */
export const SILENT_MODE_HINT_COPY =
  'Spoken replies make no sound while this iPhone is in silent mode.';

/**
 * Whether this device is still owed the one-time silent-mode hint: the platform
 * has to HAVE the caveat at all — the silent switch is iOS's own, so every
 * other platform this client runs on answers `false` and never stores anything
 * — and this device must not have been told already. A value under the key that
 * is not the literal `true` reads as not told, the same rule as a toggle, so a
 * truncated write can only repeat the hint rather than swallow it.
 */
export function shouldShowSilentModeHint(
  preferences: VoicePreferences,
  platform: string,
): boolean {
  return platform === 'ios' && preferences[SILENT_HINT_ACKNOWLEDGED_KEY] !== true;
}

/**
 * Record that this device has now been told. The hint is one-time, so the entry
 * is the literal `true` under one key, the same shape a conversation's toggle
 * has — and like a toggle it is one write, folded onto whatever the blob held,
 * so acknowledging it can never drop a voice or a flag beside it.
 */
export function acknowledgeSilentModeHint(preferences: VoicePreferences): VoicePreferences {
  if (preferences[SILENT_HINT_ACKNOWLEDGED_KEY] === true) return preferences;
  return { ...preferences, [SILENT_HINT_ACKNOWLEDGED_KEY]: true };
}

/**
 * Read a stored blob. A blob that is not a record reads as nothing stored at
 * all, and each entry is read against the space its own key names — so a
 * toggle-shaped value under a Bot's key, a voice-shaped value under a
 * conversation's, and a key from no space at all are all dropped rather than
 * guessed at. The device's own silent-mode acknowledgement is the literal
 * `true` under its prefix, the same rule a toggle is read by.
 */
export function voicePreferencesFromUnknown(value: unknown): VoicePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const preferences: VoicePreferences = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith(VOICE_KEY_PREFIX)) {
      const voice = normalizeBotVoice(entry);
      if (voice) preferences[key] = voice;
      continue;
    }
    if (key.startsWith(SPEAKER_KEY_PREFIX) && entry === true) preferences[key] = true;
    if (key.startsWith(SILENT_HINT_KEY_PREFIX) && entry === true) preferences[key] = true;
  }
  return preferences;
}

/** Read every stored preference. A refused or unreadable store is nothing stored. */
export async function loadVoicePreferences(): Promise<VoicePreferences> {
  try {
    const raw = await keyValueStorage.getItem(VOICE_PREFERENCES_STORAGE_KEY);
    if (!raw) return {};
    return voicePreferencesFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** Write the preferences back. Best-effort, like the labels and the draft. */
export async function saveVoicePreferences(preferences: VoicePreferences): Promise<void> {
  try {
    await keyValueStorage.setItem(VOICE_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // best-effort: a voice preference must never break the header it is drawn in
  }
}
