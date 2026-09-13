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

export async function loadAppSettings(): Promise<AppSettings> {
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

export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadAppSettings();
  const next = { ...current, ...patch };
  next.voiceEngine = normalizeVoiceEngine(next.voiceEngine);
  await keyValueStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
