import { keyValueStorage } from '@/lib/storage/key-value';
import {
  VOICE_ENGINE_IDS,
  loadAppSettings,
  normalizeVoiceEngine,
  saveAppSettings,
} from '@/lib/settings/app-settings';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the stored voice engine preference', () => {
  test('lists exactly the shipped choices', () => {
    expect(VOICE_ENGINE_IDS).toEqual(['auto', 'local', 'codex', 'phone']);
  });

  test('defaults to automatic on a fresh install', async () => {
    mockGet.mockResolvedValue(null);
    expect((await loadAppSettings()).voiceEngine).toBe('auto');
  });

  test('round-trips a saved choice', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ voiceEngine: 'local' }));
    expect((await loadAppSettings()).voiceEngine).toBe('local');
  });

  test('an unknown stored value reads as automatic, never a guessed engine', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ voiceEngine: 'grok' }));
    expect((await loadAppSettings()).voiceEngine).toBe('auto');
  });

  test('saving a choice persists it beside the rest of the settings', async () => {
    mockGet.mockResolvedValue(null);
    await saveAppSettings({ voiceEngine: 'codex' });
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [, raw] = mockSet.mock.calls[0];
    expect(JSON.parse(raw).voiceEngine).toBe('codex');
  });

  test('normalizeVoiceEngine accepts only a known engine id', () => {
    expect(normalizeVoiceEngine('local')).toBe('local');
    expect(normalizeVoiceEngine('codex')).toBe('codex');
    expect(normalizeVoiceEngine('phone')).toBe('phone');
    expect(normalizeVoiceEngine('auto')).toBe('auto');
    expect(normalizeVoiceEngine('grok')).toBe('auto');
    expect(normalizeVoiceEngine(undefined)).toBe('auto');
    expect(normalizeVoiceEngine(7)).toBe('auto');
  });
});
