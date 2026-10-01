import { keyValueStorage } from '@/lib/storage/key-value';

const SETTINGS_KEY = 'versutus:app-settings';

/** The engines the operator can prefer. `auto` follows the Gate's readiness order. */
export const VOICE_ENGINE_IDS = ['auto', 'local', 'codex', 'phone'] as const;
export type VoiceEngineSetting = (typeof VOICE_ENGINE_IDS)[number];

export type AppSettings = {
  autoConnect: boolean;
  onboardingComplete: boolean;
  tailscaleHost?: string;
  pcName?: string;
  lastSuccessfulUrl?: string;
  voiceEngine: VoiceEngineSetting;
};

const DEFAULT_SETTINGS: AppSettings = {
  autoConnect: true,
  onboardingComplete: false,
  voiceEngine: 'auto',
};

/** A stored value is trusted only when it names an engine this build ships. */
export function normalizeVoiceEngine(value: unknown): VoiceEngineSetting {
  return typeof value === 'string' && (VOICE_ENGINE_IDS as readonly string[]).includes(value)
    ? (value as VoiceEngineSetting)
    : 'auto';
}

/**
 * Every write of this blob is a read-modify-write, and two writers share the
 * key on different timers: the Settings screen writes the voice engine, while
 * the provider's connect path writes `lastSuccessfulUrl` and the onboarding
 * patch from its auto-connect ladder. Serialise them through one promise chain
 * so each write merges onto what the previous one stored, or the second write's
 * stale base erases the first write's field.
 */
let mutationQueueTail: Promise<void> = Promise.resolve();

function enqueueSettingsMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationQueueTail.then(task);
  // A failed write must reject its own caller without poisoning the queue: the
  // tail always settles resolved so the next write still runs.
  mutationQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** The stored blob merged over the defaults. Throws when the read cannot answer. */
async function readAppSettings(): Promise<AppSettings> {
  const raw = await keyValueStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      voiceEngine: normalizeVoiceEngine(parsed.voiceEngine),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Absent and unreadable are different facts, but a screen only ever needs
 * settings: a read the store cannot answer is answered with the defaults rather
 * than a rejection every reader would have to catch.
 */
export async function loadAppSettings(): Promise<AppSettings> {
  try {
    return await readAppSettings();
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return enqueueSettingsMutation(async () => {
    // Read through the throwing reader: an unreadable blob must refuse the
    // write, never be overwritten with defaults nobody chose.
    const current = await readAppSettings();
    const next = { ...current, ...patch };
    next.voiceEngine = normalizeVoiceEngine(next.voiceEngine);
    await keyValueStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  });
}
