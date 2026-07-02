import { keyValueStorage } from '@/lib/storage/key-value';

const SETTINGS_KEY = 'versutus:app-settings';

export type AppSettings = {
  autoConnect: boolean;
  onboardingComplete: boolean;
  tailscaleHost?: string;
  pcName?: string;
  lastSuccessfulUrl?: string;
};

const DEFAULT_SETTINGS: AppSettings = {
  autoConnect: true,
  onboardingComplete: false,
};

export async function loadAppSettings(): Promise<AppSettings> {
  const raw = await keyValueStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadAppSettings();
  const next = { ...current, ...patch };
  await keyValueStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
