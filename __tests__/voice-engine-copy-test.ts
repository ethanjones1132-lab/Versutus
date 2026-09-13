import {
  CODEX_DISCLOSURE,
  GROK_DISABLED_REASON,
  LOCAL_DISCLOSURE,
  VOICE_ENGINE_ROWS,
  voiceEngineDisclosure,
  voiceEngineReadinessCopy,
  voiceUsageCopy,
} from '@/lib/voice/voice-engine-copy';
import { HANDSFREE_DISCLOSURE } from '@/lib/voice/handsfree-call-copy';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('the engine rows Settings and the start sheet share', () => {
  test('lists automatic, this PC, ChatGPT and this phone, in order', () => {
    expect(VOICE_ENGINE_ROWS.map((row) => row.id)).toEqual(['auto', 'local', 'codex', 'phone']);
  });

  test('every row names itself and explains its cost and reach', () => {
    for (const row of VOICE_ENGINE_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.summary.length).toBeGreaterThan(0);
      expect(row.disclosure.length).toBeGreaterThan(0);
    }
  });

  test('the local disclosure promises the PC and no recording', () => {
    expect(LOCAL_DISCLOSURE).toContain('nowhere else');
    expect(LOCAL_DISCLOSURE).toContain('Nothing is recorded');
  });

  test('the codex disclosure names OpenAI and the plan allowance', () => {
    expect(CODEX_DISCLOSURE).toContain('OpenAI');
    expect(CODEX_DISCLOSURE).toContain("ChatGPT plan's voice allowance");
  });

  test('the phone row keeps the Phase 0 disclosure verbatim', () => {
    expect(voiceEngineDisclosure('phone')).toBe(HANDSFREE_DISCLOSURE);
  });

  test('an unknown preference still shows the phone disclosure, never a blank', () => {
    expect(voiceEngineDisclosure('grok' as never)).toBe(HANDSFREE_DISCLOSURE);
  });

  test('the Grok row explains why it cannot be chosen', () => {
    expect(GROK_DISABLED_REASON).toContain('dictation only');
    expect(GROK_DISABLED_REASON).toContain('text brain');
  });
});

describe('readiness copy per engine state', () => {
  test('a ready engine says so', () => {
    expect(voiceEngineReadinessCopy('ready')).toBe('Ready.');
  });

  test('the Gate reason wins when there is one', () => {
    expect(voiceEngineReadinessCopy('disabled', 'Codex realtime needs an API key.')).toBe(
      'Codex realtime needs an API key.',
    );
  });

  test('every state has a sentence even without a reason', () => {
    for (const state of [
      'not-installed',
      'installing',
      'starting',
      'unavailable',
      'over-allowance',
      'disabled',
    ] as const) {
      expect(voiceEngineReadinessCopy(state).length).toBeGreaterThan(0);
    }
  });

  test('the installing state says an install is running', () => {
    expect(voiceEngineReadinessCopy('installing')).toBe('Installing on the PC…');
  });
});

describe('Settings renders one Voice section from these words', () => {
  const settings = readSource('src', 'app', 'gateway', 'settings.tsx');

  test('reads the Gate capabilities and the shipped rows', () => {
    expect(settings).toContain("'voice.capabilities'");
    expect(settings).toContain('VOICE_ENGINE_ROWS');
    expect(settings).toContain('voiceEngineReadinessCopy');
  });

  test('saves the choice and shows the disabled Grok row', () => {
    expect(settings).toContain('saveAppSettings({ voiceEngine');
    expect(settings).toContain('GROK_ROW_LABEL');
    expect(settings).toContain('GROK_DISABLED_REASON');
  });

  test('the phone row is always offered, and audio never leaves it by default', () => {
    expect(settings).toContain("if (id === 'phone') return 'Always available on this phone.'");
  });

  test('a not-installed PC can be installed from the phone', () => {
    expect(settings).toContain("'voice.install.start'");
    expect(settings).toContain('Install on this PC');
  });

  test('the install row reports progress from the Gate', () => {
    expect(settings).toContain("'voice.install.status'");
  });

  test("shows today's minutes and the last error", () => {
    expect(voiceUsageCopy({ localMinutes: 12, codexMinutes: 0 }, null)).toBe(
      'Today: 12 min on this PC, 0 min on ChatGPT.',
    );
    expect(voiceUsageCopy(undefined, null)).toBe('No voice calls today.');
    expect(voiceUsageCopy({ localMinutes: 0, codexMinutes: 3 }, 'network')).toBe(
      'Today: 0 min on this PC, 3 min on ChatGPT. Last error: network.',
    );
    expect(settings).toContain('voiceUsageCopy');
  });
});
